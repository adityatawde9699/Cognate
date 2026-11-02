/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/relayService.ts — live sync over a dumb E2E relay (Act 2)
   ──────────────────────────────────────────────────────
   Uploads immutable signed operation batches with durable acknowledgements.
   A saved ciphertext outbox retries exactly after outages; admitted projection
   commits precede cursor advancement. The relay holds only opaque ciphertext.

   Transport: the Rust `relay_fetch` command on desktop (no CORS limits,
   self-hostable), `fetch` in the browser.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { measured } from './diagnostics';
import { getSetting, setSetting, loadOps } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
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
} from './crypto';
import { mergeIntoApp } from './syncService';
import { validateRelayUrl } from './relayTransport';
import { pushBatches, pullBatches, withSyncLock, checkRetryWindow } from './batchSync';

const URL_KEY = 'sync_relay_url';
const PASS_SECRET = 'sync_passphrase';
const SETUP_CODE_SECRET = 'sync_setup_code';
const DELETE_TOKEN_SECRET = 'sync_delete_token';
const VERSION_KEY = 'sync_protocol_version';

export interface RelayConfig {
  url: string;
  passphrase: string;
  version: 2 | 3;
  setupCode?: string;
  deleteToken?: string;
}

export interface WorkspaceBinding {
  version?: 2 | 3;
  url: string;
  room: string;
  setup_code_hash?: string;
  v2_fallback?: { room: string };
}

export interface SyncResult { pushed: number; pulledBlobs: number; mergedOps: number; upserts: number; deletes: number; }

export async function getWorkspaceBinding(): Promise<WorkspaceBinding | null> {
  const bindingRaw = await getSetting('sync_workspace_binding', '');
  if (!bindingRaw) return null;
  try {
    return JSON.parse(bindingRaw);
  } catch {
    return null;
  }
}

// ── Configuration (URL in settings, secrets in the OS keychain) ──

export async function enableSyncV3(
  url: string,
  passphrase: string,
  setupCodeInput?: string,
  deleteTokenInput?: string
): Promise<{ setupCode: string; deleteToken: string; room: string }> {
  validateRelayUrl(url.trim());
  if (new URL(url.trim()).search) throw new Error('Relay base URL cannot contain a query.');

  const passCheck = validatePassphrase(passphrase);
  if (!passCheck.valid) throw new Error(passCheck.error);

  const setupCode = setupCodeInput ? setupCodeInput.trim() : encodeSetupCode(generateSetupCode());
  const decodedSetup = decodeSetupCode(setupCode);
  const deleteToken = deleteTokenInput ? deleteTokenInput.trim() : generateDeleteToken();

  const creds = await deriveSyncV3(passphrase, decodedSetup);
  const nextUrl = url.trim().replace(/\/$/, '');

  const current = await getConfig();
  if (current && (current.passphrase !== passphrase || current.url !== nextUrl || current.setupCode !== setupCode)) {
    throw new Error('Changing an active workspace key or relay requires an explicit migration. Export a verified recovery kit and operation bundle first; reconnect with the existing configuration.');
  }

  const binding = await getWorkspaceBinding();
  if (!current && binding && (await loadOps()).length) {
    const matchesV3 = binding.url === nextUrl && binding.room === creds.room;
    const matchesFallback = binding.url === nextUrl && binding.v2_fallback?.room === creds.room;
    if (!matchesV3 && !matchesFallback) {
      throw new Error('This workspace is bound to its previous sync configuration. Use an explicit migration before changing its key or relay.');
    }
  }

  await setSetting(URL_KEY, nextUrl);
  await setSecret(PASS_SECRET, passphrase);
  await setSecret(SETUP_CODE_SECRET, setupCode);
  await setSecret(DELETE_TOKEN_SECRET, deleteToken);
  await setSetting(VERSION_KEY, '3');

  if (!binding) {
    const setupCodeHash = await hashDeleteToken(setupCode);
    await setSetting('sync_workspace_binding', JSON.stringify({
      version: 3,
      url: nextUrl,
      room: creds.room,
      setup_code_hash: setupCodeHash,
    }));
  }

  return { setupCode, deleteToken, room: creds.room };
}

export async function enableSync(
  url: string,
  passphrase: string,
  options?: { setupCode?: string; deleteToken?: string }
): Promise<void> {
  if (options?.setupCode) {
    await enableSyncV3(url, passphrase, options.setupCode, options.deleteToken);
    return;
  }
  validateRelayUrl(url.trim());
  if (new URL(url.trim()).search) throw new Error('Relay base URL cannot contain a query.');
  const current = await getConfig(), nextUrl = url.trim().replace(/\/$/, '');
  if (current && (current.passphrase !== passphrase || current.url !== nextUrl)) {
    throw new Error('Changing an active workspace key or relay requires an explicit migration. Export a verified recovery kit and operation bundle first; reconnect with the existing configuration.');
  }
  const binding = await getWorkspaceBinding();
  if (!current && binding && (await loadOps()).length) {
    const v2Room = await deriveRoomId(passphrase);
    const matchesV2 = binding.url === nextUrl && binding.room === v2Room;
    const matchesFallback = binding.url === nextUrl && binding.v2_fallback?.room === v2Room;
    if (!matchesV2 && !matchesFallback) {
      throw new Error('This workspace is bound to its previous sync configuration. Use an explicit migration before changing its key or relay.');
    }
  }
  await setSetting(URL_KEY, nextUrl);
  await setSecret(PASS_SECRET, passphrase);
  await setSecret(SETUP_CODE_SECRET, '');
  await setSecret(DELETE_TOKEN_SECRET, '');
  await setSetting(VERSION_KEY, '2');
  if (!binding) await setSetting('sync_workspace_binding', JSON.stringify({ url: nextUrl, room: await deriveRoomId(passphrase) }));
}

export async function disableSync(): Promise<void> {
  await setSetting(URL_KEY, '');
  await setSecret(PASS_SECRET, '');
  await setSecret(SETUP_CODE_SECRET, '');
  await setSecret(DELETE_TOKEN_SECRET, '');
  await setSetting(VERSION_KEY, '');
}

export async function getConfig(): Promise<RelayConfig | null> {
  const url = (await getSetting(URL_KEY, '')) || '';
  const passphrase = (await getSecret(PASS_SECRET)) || '';
  if (!url || !passphrase) return null;
  const versionStr = await getSetting(VERSION_KEY, '');
  const setupCode = (await getSecret(SETUP_CODE_SECRET)) || '';
  const deleteToken = (await getSecret(DELETE_TOKEN_SECRET)) || '';
  const version: 2 | 3 = versionStr === '3' || (versionStr === '' && setupCode !== '') ? 3 : 2;
  return {
    url,
    passphrase,
    version,
    ...(setupCode ? { setupCode } : {}),
    ...(deleteToken ? { deleteToken } : {}),
  };
}

export async function isSyncEnabled(): Promise<boolean> {
  return (await getConfig()) !== null;
}

// ── Push / pull / sync ───────────────────────────────────

/** Whole-log / batch sync pushes local uncommitted batches. */
export async function pushLocal(cfg: RelayConfig, key: CryptoKey, room: string): Promise<number> {
  return pushBatches({ url: cfg.url, room, key, context: { kind: 'workspace', id: room, epoch: 1 } }, await loadOps());
}

export async function pullRemote(cfg: RelayConfig, key: CryptoKey, room: string) {
  const pulled = await pullBatches(
    { url: cfg.url, room, key, context: { kind: 'workspace', id: room, epoch: 1 } },
    async (archive) => mergeIntoApp(archive.flatMap((batch) => batch.ops))
  );
  return { pulledBlobs: pulled.batches, mergedOps: pulled.result.applied, upserts: pulled.result.upserts, deletes: pulled.result.deletes };
}

export async function syncNow(options: { automatic?: boolean } = {}): Promise<SyncResult> {
  return measured('sync', () => syncNowInner(options));
}

async function syncNowInner(options: { automatic?: boolean }): Promise<SyncResult> {
  const cfg = await getConfig();
  if (!cfg) throw new Error('Sync is not set up. Add a relay URL and passphrase in Settings.');
  let key: CryptoKey;
  let room: string;
  if (cfg.version === 3 && cfg.setupCode) {
    const creds = await deriveSyncV3(cfg.passphrase, decodeSetupCode(cfg.setupCode));
    key = creds.key;
    room = creds.room;
  } else {
    key = await deriveSyncKey(cfg.passphrase);
    room = await deriveRoomId(cfg.passphrase);
  }
  if (options.automatic) await checkRetryWindow(room, cfg.url);
  return withSyncLock(room, async () => ({ pushed: await pushLocal(cfg, key, room), ...await pullRemote(cfg, key, room) }));
}

