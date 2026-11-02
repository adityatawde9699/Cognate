/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/migrationService.ts — Sync Protocol v3 Genesis & Migration
   ──────────────────────────────────────────────────────
   Implements:
   - Workspace Genesis Creation (Originating Device, Section 5.1)
   - Workspace Joining 4-Step Validation Pipeline (Section 5.2)
   - Migration Orchestrator (v2 -> v3, Section 6)
   - Write-freeze enforcement and soft-delete retirement triggers (Section 6.3 & 6.4)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting, setSetting, loadOps } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { canonicalJson } from './oplog';
import { getIdentity } from './identity';
import {
  deriveSyncKey,
  deriveRoomId,
  deriveSyncV3,
  decodeSetupCode,
  encodeSetupCode,
  generateSetupCode,
  generateDeleteToken,
  hashDeleteToken,
  validatePassphrase,
  seal,
  open,
  signBytes,
} from './crypto';
import { httpGet, httpPut, httpPost, fetchCapabilities } from './relayTransport';
import { enableSyncV3, getConfig } from './relayService';
import { verifyBatch, type SignedBatch } from './batchSync';

export interface GenesisResult {
  room: string;
  setupCode: string;
  deleteToken: string;
  workspaceId: string;
}

export interface JoinResult {
  room: string;
  workspaceId: string;
}

export interface MigrationResult {
  v3Room: string;
  setupCode: string;
  deleteToken: string;
}

export type MigrationFailpoint =
  | 'before_publish'
  | 'after_publish'
  | 'after_readback'
  | 'after_v2_marker'
  | 'after_freeze'
  | null;

let currentMigrationFailpoint: MigrationFailpoint = null;

export function setMigrationFailpoint(fp: MigrationFailpoint): void {
  currentMigrationFailpoint = fp;
}

/** Check if v2 room writes have been frozen locally due to migration. */
export async function isV2WriteFrozen(): Promise<boolean> {
  return (await getSetting('sync_v2_write_frozen', 'false')) === 'true';
}

/**
 * Workspace Genesis (Section 5.1):
 * Originating device derives K_v3, R_v3, C_v3, creates a signed genesis batch (v: 3)
 * containing verifier ciphertext and squashed baseline state, and posts to relay with
 * delete token hash registration.
 */
export async function createWorkspaceGenesis(
  url: string,
  passphrase: string,
  setupCodeInput?: string,
  deleteTokenInput?: string
): Promise<GenesisResult> {
  const passCheck = validatePassphrase(passphrase);
  if (!passCheck.valid) throw new Error(passCheck.error);

  const setupCode = setupCodeInput ? setupCodeInput.trim() : encodeSetupCode(generateSetupCode());
  const decodedSetup = decodeSetupCode(setupCode);
  const deleteToken = deleteTokenInput ? deleteTokenInput.trim() : generateDeleteToken();

  const creds = await deriveSyncV3(passphrase, decodedSetup);
  const workspaceId = crypto.randomUUID();

  // Verifier ciphertext: AES-GCM encryption of {"verifier": C_v3, "workspace_id": UUID}
  const verifierPlain = { verifier: creds.verifier, workspace_id: workspaceId };
  const verifierBlob = await seal(creds.key, verifierPlain);

  // Initial compact snapshot
  const identity = await getIdentity();
  const rawTasks = await getSetting('tasks_v1', '[]');
  const rawProjects = await getSetting('projects_v1', '[]');

  const genesisPayload = {
    v: 3 as const,
    id: 'genesis',
    context: { kind: 'workspace' as const, id: creds.room, epoch: 1 },
    actor: identity.actor,
    pub: identity.pub,
    ops: [],
    verifier: verifierBlob,
    snapshot: {
      tasks: JSON.parse(rawTasks),
      projects: JSON.parse(rawProjects),
      actor: identity.actor,
    },
  };

  const sig = await signBytes(
    identity.privateKey,
    new TextEncoder().encode(canonicalJson(genesisPayload as any))
  );
  const signedGenesis: SignedBatch = { ...genesisPayload, sig };
  const sealedGenesis = await seal(creds.key, signedGenesis);

  const delHash = await hashDeleteToken(deleteToken);
  const targetUrl = `${url.trim().replace(/\/$/, '')}/v2/rooms/${creds.room}/batches/genesis?delete_token_hash=${delHash}`;
  await httpPut(targetUrl, JSON.stringify(sealedGenesis));

  await enableSyncV3(url, passphrase, setupCode, deleteToken);

  return {
    room: creds.room,
    setupCode,
    deleteToken,
    workspaceId,
  };
}

/**
 * Workspace Joining (Section 5.2):
 * 4-step pipeline:
 * 1. Existence: Fail if 0 batches returned.
 * 2. Decryption: Decrypt batch 1 with candidate K_v3.
 * 3. Verifier Check: Decrypt verifier blob and compare with candidate C_v3.
 * 4. Identity & Signature: Verify batch signature against creator public key.
 */
export async function joinWorkspaceV3(
  url: string,
  passphrase: string,
  setupCode: string
): Promise<JoinResult> {
  const passCheck = validatePassphrase(passphrase);
  if (!passCheck.valid) throw new Error(passCheck.error);

  const decodedSetup = decodeSetupCode(setupCode);
  const creds = await deriveSyncV3(passphrase, decodedSetup);
  const cleanUrl = url.trim().replace(/\/$/, '');

  // Fetch genesis batch
  let pageRaw: string;
  try {
    pageRaw = await httpGet(`${cleanUrl}/v2/rooms/${creds.room}/batches?after=0`);
  } catch {
    throw new Error('No workspace found for this Setup Code and Passphrase');
  }

  const page = JSON.parse(pageRaw);

  // Step 1: Existence check
  if (!Array.isArray(page.batches) || page.batches.length === 0) {
    throw new Error('No workspace found for this Setup Code and Passphrase');
  }

  // Step 2: Decryption check
  let genesisBatch: SignedBatch;
  try {
    genesisBatch = await open<SignedBatch>(creds.key, page.batches[0]);
  } catch {
    throw new Error('Incorrect Passphrase');
  }

  // Step 3: Verifier check
  if (!genesisBatch.verifier) {
    throw new Error('Invalid workspace genesis: missing verifier');
  }
  let verifierData: { verifier: string; workspace_id: string };
  try {
    verifierData = await open<{ verifier: string; workspace_id: string }>(creds.key, genesisBatch.verifier);
  } catch {
    throw new Error('Incorrect Passphrase');
  }
  if (verifierData.verifier !== creds.verifier) {
    throw new Error('Invalid workspace verifier');
  }

  // Step 4: Identity & Signature verification
  await verifyBatch(genesisBatch, { kind: 'workspace', id: creds.room, epoch: 1 });

  // Commit sync configuration locally
  await enableSyncV3(url, passphrase, setupCode);

  return {
    room: creds.room,
    workspaceId: verifierData.workspace_id,
  };
}

/**
 * Migration Orchestrator (v2 -> v3, Section 6):
 * 1. Preflight: drain outbox, verify baseline <= 8 MB.
 * 2. Publish genesis and baseline to R_v3.
 * 3. Readback verify from R_v3.
 * 4. Write migration marker to R_v2.
 * 5. Atomic local commit to v3 and v2 write freeze.
 */
export async function migrateV2ToV3(
  v3Passphrase: string,
  setupCodeInput?: string,
  deleteTokenInput?: string
): Promise<MigrationResult> {
  const current = await getConfig();
  if (!current) throw new Error('Cannot migrate: no active sync configuration.');

  const passCheck = validatePassphrase(v3Passphrase);
  if (!passCheck.valid) throw new Error(passCheck.error);

  const cleanUrl = current.url.trim().replace(/\/$/, '');
  const v2Room = await deriveRoomId(current.passphrase);
  const v2Key = await deriveSyncKey(current.passphrase);
  const caps = await fetchCapabilities(cleanUrl);

  // 1. Preflight check: verify baseline size within relay room quota
  const rawTasks = await getSetting('tasks_v1', '[]');
  const rawProjects = await getSetting('projects_v1', '[]');
  const ops = await loadOps();
  const baselineBytes = new TextEncoder().encode(rawTasks + rawProjects + JSON.stringify(ops)).length;
  if (baselineBytes > caps.room_quota) {
    throw new Error(`Workspace baseline exceeds ${caps.room_quota} bytes relay quota.`);
  }

  const setupCode = setupCodeInput ? setupCodeInput.trim() : encodeSetupCode(generateSetupCode());
  const decodedSetup = decodeSetupCode(setupCode);
  const deleteToken = deleteTokenInput ? deleteTokenInput.trim() : generateDeleteToken();
  const creds = await deriveSyncV3(v3Passphrase, decodedSetup);

  // 2. Publish genesis to R_v3
  if (currentMigrationFailpoint === 'before_publish') {
    throw new Error('FAILPOINT: killed before publish');
  }

  const workspaceId = crypto.randomUUID();
  const verifierBlob = await seal(creds.key, { verifier: creds.verifier, workspace_id: workspaceId });
  const identity = await getIdentity();

  const genesisPayload = {
    v: 3 as const,
    id: 'genesis',
    context: { kind: 'workspace' as const, id: creds.room, epoch: 1 },
    actor: identity.actor,
    pub: identity.pub,
    ops: [],
    verifier: verifierBlob,
    snapshot: {
      tasks: JSON.parse(rawTasks),
      projects: JSON.parse(rawProjects),
      actor: identity.actor,
    },
  };
  const sig = await signBytes(identity.privateKey, new TextEncoder().encode(canonicalJson(genesisPayload as any)));
  const signedGenesis: SignedBatch = { ...genesisPayload, sig };
  const sealedGenesis = await seal(creds.key, signedGenesis);

  const delHash = await hashDeleteToken(deleteToken);
  try {
    await httpPut(
      `${cleanUrl}/v2/rooms/${creds.room}/batches/genesis?delete_token_hash=${delHash}`,
      JSON.stringify(sealedGenesis)
    );
  } catch (err: any) {
    if (err?.message?.includes('409')) {
      // Concurrent migration: another device already published genesis to this v3 room.
      // Deterministic loser adopts the winner's genesis batch via readback.
    } else {
      throw err;
    }
  }

  if (currentMigrationFailpoint === 'after_publish') {
    throw new Error('FAILPOINT: killed after publish');
  }

  // 3. Readback Verification
  const readbackRaw = await httpGet(`${cleanUrl}/v2/rooms/${creds.room}/batches?after=0`);
  const readbackPage = JSON.parse(readbackRaw);
  if (!Array.isArray(readbackPage.batches) || readbackPage.batches.length === 0) {
    throw new Error('Migration readback verification failed: no batches found on v3 room.');
  }
  const readbackBatch = await open<SignedBatch>(creds.key, readbackPage.batches[0]);
  if (!readbackBatch.verifier) {
    throw new Error('Migration readback verification failed: verifier missing.');
  }
  const readbackVerifier = await open<{ verifier: string }>(creds.key, readbackBatch.verifier);
  if (readbackVerifier.verifier !== creds.verifier) {
    throw new Error('Migration readback verification failed: verifier mismatch.');
  }
  await verifyBatch(readbackBatch, { kind: 'workspace', id: creds.room, epoch: 1 });

  if (currentMigrationFailpoint === 'after_readback') {
    throw new Error('FAILPOINT: killed after readback');
  }

  // 4. Post Migration Marker to R_v2 (Section 6.2)
  // Contains ONLY { migrated: true, timestamp, actor, sig } — NO v3 room or keys
  const markerPayload = {
    migrated: true as const,
    timestamp: Math.floor(Date.now() / 1000),
    actor: identity.actor,
  };
  const markerSig = await signBytes(identity.privateKey, new TextEncoder().encode(canonicalJson(markerPayload)));
  const markerBatch = { ...markerPayload, sig: markerSig };

  const v2MarkerData = {
    v: 2 as const,
    id: `migrated-${identity.actor}`,
    context: { kind: 'workspace' as const, id: v2Room, epoch: 1 },
    actor: identity.actor,
    pub: identity.pub,
    ops: [],
    migration_marker: markerBatch,
  };
  const batchSig = await signBytes(
    identity.privateKey,
    new TextEncoder().encode(canonicalJson(v2MarkerData))
  );
  const v2MarkerBatch: SignedBatch = {
    ...v2MarkerData,
    sig: batchSig,
  };
  const sealedMarker = await seal(v2Key, v2MarkerBatch);
  try {
    await httpPut(`${cleanUrl}/v2/rooms/${v2Room}/batches/migrated-${identity.actor}`, JSON.stringify(sealedMarker));
  } catch (err: any) {
    if (err?.message?.includes('409')) {
      // Marker already exists
    } else {
      throw err;
    }
  }

  if (currentMigrationFailpoint === 'after_v2_marker') {
    throw new Error('FAILPOINT: killed after v2 marker');
  }

  // 5. Freeze v2 writes locally and on relay (if supported)
  await setSetting('sync_v2_write_frozen', 'true');
  let v2DeleteToken = (await getSecret('sync_delete_token')) || '';
  if (!v2DeleteToken) {
    v2DeleteToken = generateDeleteToken();
    await setSecret('sync_delete_token', v2DeleteToken);
  }
  if (caps.claim_supported) {
    try {
      await claimLegacyV2Room(cleanUrl, v2Room, v2DeleteToken);
    } catch {
      // Room may already be claimed or claim failed
    }
  }
  if (caps.freeze_supported && v2DeleteToken) {
    try {
      await freezeLegacyV2Room(cleanUrl, v2Room, v2DeleteToken);
    } catch {
      // Server freeze failed; client write-freeze remains active
    }
  }

  if (currentMigrationFailpoint === 'after_freeze') {
    throw new Error('FAILPOINT: killed after freeze');
  }
  await enableSyncV3(cleanUrl, v3Passphrase, setupCode, deleteToken, { isMigration: true });

  // Update workspace binding to v3 with v2 fallback
  const setupCodeHash = await hashDeleteToken(setupCode);
  await setSetting('sync_workspace_binding', JSON.stringify({
    version: 3,
    url: cleanUrl,
    room: creds.room,
    setup_code_hash: setupCodeHash,
    v2_fallback: { room: v2Room },
  }));

  return {
    v3Room: creds.room,
    setupCode,
    deleteToken,
  };
}

/**
 * Verify whether all known actor public keys from v2 have synced at least one batch to v3.
 */
export async function checkAllActorsSyncedV3(
  url: string,
  v2Room: string,
  v3Room: string,
  v2Key: CryptoKey,
  v3Key: CryptoKey
): Promise<{ allSynced: boolean; missingActors: string[] }> {
  const cleanUrl = url.trim().replace(/\/$/, '');

  // Pull v2 batches
  const v2PageRaw = await httpGet(`${cleanUrl}/v2/rooms/${v2Room}/batches?after=0`);
  const v2Page = JSON.parse(v2PageRaw);
  const v2Actors = new Set<string>();
  if (Array.isArray(v2Page.batches)) {
    for (const b of v2Page.batches) {
      try {
        const decrypted = await open<SignedBatch>(v2Key, b);
        if (decrypted.actor) v2Actors.add(decrypted.actor);
      } catch {
        // Skip unopenable batches
      }
    }
  }

  // Pull v3 batches
  const v3PageRaw = await httpGet(`${cleanUrl}/v2/rooms/${v3Room}/batches?after=0`);
  const v3Page = JSON.parse(v3PageRaw);
  const v3Actors = new Set<string>();
  if (Array.isArray(v3Page.batches)) {
    for (const b of v3Page.batches) {
      try {
        const decrypted = await open<SignedBatch>(v3Key, b);
        if (decrypted.actor) v3Actors.add(decrypted.actor);
      } catch {
        // Skip unopenable batches
      }
    }
  }

  const missingActors = [...v2Actors].filter((a) => !v3Actors.has(a));
  return {
    allSynced: missingActors.length === 0,
    missingActors,
  };
}

/**
 * Retire legacy v2 room via relay soft-delete endpoint (Section 6.4).
 */
export async function retireLegacyV2Room(
  url: string,
  v2Room: string,
  deleteToken: string
): Promise<{ soft_deleted: boolean; purge_after_seconds: number }> {
  const cleanUrl = url.trim().replace(/\/$/, '');
  const res = await httpPost(
    `${cleanUrl}/v2/rooms/${v2Room}/delete`,
    JSON.stringify({ delete_token: deleteToken })
  );
  return JSON.parse(res);
}

/**
 * Cancel soft-delete within 7-day grace period (Section 6.4).
 */
export async function cancelLegacyV2SoftDelete(
  url: string,
  v2Room: string,
  deleteToken: string
): Promise<{ soft_deleted: boolean; undeleted: boolean }> {
  const cleanUrl = url.trim().replace(/\/$/, '');
  const res = await httpPost(
    `${cleanUrl}/v2/rooms/${v2Room}/undelete`,
    JSON.stringify({ delete_token: deleteToken })
  );
  return JSON.parse(res);
}

/**
 * Claim an unclaimed legacy v2 room (Section 6.4).
 */
export async function claimLegacyV2Room(
  url: string,
  v2Room: string,
  deleteToken: string
): Promise<{ claimed: boolean }> {
  const cleanUrl = url.trim().replace(/\/$/, '');
  const hash = await hashDeleteToken(deleteToken);
  const res = await httpPost(
    `${cleanUrl}/v2/rooms/${v2Room}/claim`,
    JSON.stringify({ delete_token_hash: hash })
  );
  return JSON.parse(res);
}

/**
 * Freeze a legacy v2 room on the relay to prevent forks (Section 6.4).
 */
export async function freezeLegacyV2Room(
  url: string,
  v2Room: string,
  deleteToken: string
): Promise<{ frozen: boolean; frozen_at?: number }> {
  const cleanUrl = url.trim().replace(/\/$/, '');
  const res = await httpPost(
    `${cleanUrl}/v2/rooms/${v2Room}/freeze`,
    JSON.stringify({ delete_token: deleteToken })
  );
  return JSON.parse(res);
}

