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

import { getSetting, setSetting } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { actorId } from './oplogStore';
import {
  generateSigningKeypair,
  exportPrivateKey,
  importPrivateKey,
  exportPublicKey,
  importPublicKey,
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

    if (privB64 && pubB64) {
      cached = {
        actor,
        pub: pubB64,
        privateKey: await importPrivateKey(privB64),
        publicKey: await importPublicKey(pubB64),
      };
      return cached;
    }

    // First run on this device: mint and persist a keypair.
    const kp = await generateSigningKeypair();
    const freshPriv = await exportPrivateKey(kp.privateKey);
    const freshPub = await exportPublicKey(kp.publicKey);
    await setSecret(PRIV_SECRET, freshPriv);
    await setSetting(PUB_SETTING, freshPub);
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

/** Reset module state — test seam only. */
export function _resetForTests(): void {
  cached = null;
  pending = null;
}
