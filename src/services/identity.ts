/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/identity.ts — this device's signing identity (Act 3)
   ──────────────────────────────────────────────────────
   Act 2 gave each install a CRDT *actor id* (the total-order tiebreak). Act 3
   gives that same actor a *cryptographic* identity: an ECDSA P-256 keypair.

     • The private key is generated once and kept in the OS keychain (via the
       same secrets layer that holds API keys / the sync passphrase). It never
       leaves the device and is reloaded non-extractable.
     • The public key is published (in settings) so it can be handed to a
       share's member roster, binding actor id → verification key. Peers verify
       every op against it before admitting the op (see collab.ts).

   This is the bridge between the local mutation choke point (oplogStore, which
   appends raw ops) and shared documents (which require *signed* ops): local
   storage stays raw — your own device trusts itself — and signing is applied
   at the share/relay boundary via `signLocalOps`. See identity.test.ts.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting, setSetting, USE_BROWSER_WORKSPACE, registerBrowserIdentity, replaceBrowserIdentity, IS_TAURI, loadOps } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { encryptBrowserSecret,decryptBrowserSecret } from '../utils/browserVault';
import { actorId, logCollabCheckpoint, _resetForTests as resetClock } from './oplogStore';
import { materialize, type EntityState } from './oplog';
import {
  generateSigningKeypair,
  exportPrivateKey,
  importPrivateKey,
  exportPublicKey,
  importPublicKey,
  signBytes,
  verifyBytes,
} from './crypto';
import { signOps, type SignedOp } from './collab';
import type { Op } from './oplog';

const PRIV_SECRET = 'crdt_signing_key'; // pkcs8 base64, in the keychain
const PUB_SETTING = 'crdt_signing_pub'; // raw base64, publishable

export interface Identity {
  actor: string; // == the CRDT actor id (op.hlc.actor)
  pub: string;   // base64 public key, for the roster
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

let cached: Identity | null = null;
let pending: Promise<Identity> | null = null;

/**
 * Load this device's signing identity, generating + persisting one on first
 * use. Bound to the existing CRDT actor id so signatures and op authorship
 * agree. Idempotent and safe to call from many places (single-flight).
 */
export async function getIdentity(): Promise<Identity> {
  if (cached) return cached;
  if (pending) return pending;
  pending = (async () => {
    const actor = await actorId();
    const privB64 = await getSecret(PRIV_SECRET);
    const pubB64 = await getSetting(PUB_SETTING, '');

    if (!actor) throw new Error('Device actor identity is unavailable.');
    if (Boolean(privB64) !== Boolean(pubB64)) {
      throw new Error('Signing identity is incomplete. Restore a recovery kit, or replace this device\'s identity in Settings → Sharing.');
    }
    const binding = await getSetting('crdt_signing_binding', '');
    if (privB64 && pubB64) {
      const privateKey = await importPrivateKey(privB64);
      const publicKey = await importPublicKey(pubB64);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      if (!await verifyBytes(publicKey,await signBytes(privateKey,challenge),challenge)) {
        throw new Error('Stored signing keys do not match. Restore a recovery kit, or replace this device\'s identity in Settings → Sharing.');
      }
      const expectedBinding = JSON.stringify({actor,pub:pubB64});
      if (binding && binding !== expectedBinding) throw new Error('Device actor and signing key binding changed. Restore your identity.');
      if (!binding) await setSetting('crdt_signing_binding',expectedBinding);
      cached = {
        actor,
        pub: pubB64,
        privateKey,
        publicKey,
      };
      return cached;
    }

    if (binding) throw new Error('Registered signing keys are missing. Restore a recovery kit, or replace this device\'s identity in Settings → Sharing.');
    // First run on this device: mint and persist a keypair.
    const kp = await generateSigningKeypair();
    const freshPriv = await exportPrivateKey(kp.privateKey);
    const freshPub = await exportPublicKey(kp.publicKey);
    if (USE_BROWSER_WORKSPACE) {
      const installed = await registerBrowserIdentity(actor,await encryptBrowserSecret(freshPriv),freshPub);
      const privateKey = await importPrivateKey(await decryptBrowserSecret(installed.priv));
      const publicKey = await importPublicKey(installed.pub);
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      if (!await verifyBytes(publicKey,await signBytes(privateKey,challenge),challenge)) throw new Error('Registered signing keys do not match.');
      cached={actor,pub:installed.pub,privateKey,publicKey};
      return cached;
    }
    await setSecret(PRIV_SECRET, freshPriv);
    await setSetting(PUB_SETTING, freshPub);
    await setSetting('crdt_signing_binding',JSON.stringify({actor,pub:freshPub}));
    cached = { actor, pub: freshPub, privateKey: kp.privateKey, publicKey: kp.publicKey };
    return cached;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** The publishable half of our identity — what a roster entry records. */
export async function publicIdentity(): Promise<{ actor: string; pub: string }> {
  const id = await getIdentity();
  return { actor: id.actor, pub: id.pub };
}

/** Sign ops with this device's identity (for pushing into a shared doc). */
export async function signLocalOps(ops: Op[]): Promise<SignedOp[]> {
  const id = await getIdentity();
  return signOps(id.privateKey, id.pub, ops);
}

/** Warm the identity at startup (best-effort) so the keypair exists early. */
export async function ensureIdentity(): Promise<void> {
  try {
    await getIdentity();
  } catch (e) {
    console.warn('[identity] init failed:', e);
  }
}

/** Shared-project entities stay with their share's roster; everything else is
 * this person's own data and follows them to a new identity. */
function personalEntity(entity: string): boolean {
  return !entity.startsWith('audit:') && !entity.startsWith('member:') && !entity.startsWith('comment:');
}

/**
 * Retire this device's actor and signing key and start a fresh pair. Use when
 * the keychain lost the key or the key may be exposed; a recovery kit is the
 * way to keep the old identity. The new actor's clock starts past all
 * history, and everything the old actor wrote is re-logged under the new one
 * so peers receive edits the old key can no longer sign. Shared projects must
 * re-invite this device: rosters name the old key.
 */
export async function replaceDeviceIdentity(): Promise<{ actor: string; previous: string; relogged: number }> {
  const previous = await actorId();
  if (!previous) throw new Error('Device actor identity is unavailable.');
  const actor = crypto.randomUUID().replace(/-/g, '');
  const kp = await generateSigningKeypair();
  const priv = await exportPrivateKey(kp.privateKey);
  const pub = await exportPublicKey(kp.publicKey);
  if (USE_BROWSER_WORKSPACE) {
    await replaceBrowserIdentity(previous, actor, await encryptBrowserSecret(priv), pub);
  } else {
    const oldKey = await getSecret(PRIV_SECRET);
    await setSecret(PRIV_SECRET, priv);
    if (await getSecret(PRIV_SECRET) !== priv) throw new Error('The new signing key could not be saved to the keychain.');
    try {
      if (IS_TAURI) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('replace_device_identity', { actor, pubKey: pub });
      } else {
        await replaceBrowserIdentity(previous, actor, priv, pub);
      }
    } catch (error) {
      await setSecret(PRIV_SECRET, oldKey ?? '');
      throw error;
    }
  }
  cached = null;
  pending = null;
  resetClock();

  const ops = await loadOps();
  const touched = new Set(ops.filter(op => op.hlc.actor === previous && personalEntity(op.entity)).map(op => op.entity));
  const states = materialize(ops);
  const live = new Map<string, EntityState>();
  const deleted: string[] = [];
  for (const entity of touched) {
    const state = states.get(entity);
    if (state) live.set(entity, state);
    else deleted.push(entity);
  }
  if (live.size || deleted.length) await logCollabCheckpoint(live, deleted);
  const fresh = await getIdentity();
  if (fresh.actor !== actor || fresh.pub !== pub) throw new Error('Replacement identity did not take effect. Restart Cognate.');
  return { actor, previous, relogged: live.size + deleted.length };
}

/** Reset module state — test seam only. */
export function _resetForTests(): void {
  cached = null;
  pending = null;
}
