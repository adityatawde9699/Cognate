/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/crypto.ts — end-to-end encryption for sync (Act 2)
   ──────────────────────────────────────────────────────
   The relay stores only ciphertext; the key never leaves the device. A
   passphrase is stretched with PBKDF2 into an AES-GCM key (encrypts the
   op-log bundle) and, under a different label, into the opaque "room" id the
   relay buckets by — so the server sees random ids and sealed blobs, nothing
   more. Security rests on passphrase entropy: use a strong one.

   Built on WebCrypto (`crypto.subtle`), which exists in the Tauri webview,
   the browser, and Node — so this is identical everywhere and unit-tested.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const PBKDF2_ITERS = 150_000;
const KEY_SALT = 'cognate-sync-key-v1';
const ROOM_SALT = 'cognate-sync-room-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

function subtle(): SubtleCrypto {
  const c = (globalThis as any).crypto;
  if (!c?.subtle) throw new Error('WebCrypto unavailable in this environment.');
  return c.subtle;
}
function randomBytes(n: number): Uint8Array {
  return (globalThis as any).crypto.getRandomValues(new Uint8Array(n));
}
/** Copy bytes into a fresh ArrayBuffer-backed view (satisfies WebCrypto's BufferSource). */
function buf(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface SealedBlob {
  v: 1;
  nonce: string; // base64 (96-bit AES-GCM IV)
  ct: string;    // base64 ciphertext + tag
}

/** Stretch a passphrase into a non-extractable AES-GCM key. */
export async function deriveKey(passphrase: string): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: enc.encode(KEY_SALT), iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Derive the relay "room" id from the passphrase under a distinct label.
 * Knowing the room reveals nothing about the key (different KDF inputs), and
 * the relay only ever sees this opaque hex id.
 */
export async function deriveRoomId(passphrase: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(`${ROOM_SALT}|${passphrase}`));
  return toHex(digest).slice(0, 32);
}

/** Encrypt a JSON-serializable value into a sealed blob. */
export async function seal(key: CryptoKey, value: unknown): Promise<SealedBlob> {
  const nonce = randomBytes(12);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, enc.encode(JSON.stringify(value)));
  return { v: 1, nonce: toB64(nonce), ct: toB64(new Uint8Array(ct)) };
}

/** Decrypt a sealed blob. Throws if the key is wrong or the blob was tampered with. */
export async function open<T>(key: CryptoKey, blob: SealedBlob): Promise<T> {
  if (!blob || blob.v !== 1 || !blob.nonce || !blob.ct) throw new Error('Malformed sealed blob.');
  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromB64(blob.nonce)) }, key, buf(fromB64(blob.ct)));
  } catch {
    throw new Error('Decryption failed — wrong passphrase or corrupted data.');
  }
  return JSON.parse(dec.decode(plain)) as T;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Per-document share keys (Act 3: multiplayer scoping)
   ──────────────────────────────────────────────────────
   Act 2 sealed the WHOLE workspace under one passphrase-derived key in one
   room. Sharing a single project that way would leak everything else. So a
   share gets its OWN random 256-bit data key (the "share secret" — a
   capability you hand a teammate out-of-band) and its OWN relay room derived
   from that secret. Read access == holding the secret; nothing the workspace
   passphrase protects is exposed. The relay still only ever sees an opaque
   room id and ciphertext.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const SHARE_ROOM_SALT = 'cognate-share-room-v1';

/** Mint a fresh random share secret (base64 of 256 random bits). The capability. */
export function generateShareSecret(): string {
  return toB64(randomBytes(32));
}

/** Import a share secret into a non-extractable AES-GCM key for seal/open. */
export async function importShareKey(secretB64: string): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(fromB64(secretB64)), { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** The relay room for a share, derived from its secret under a distinct label. */
export async function roomIdForSecret(secretB64: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(`${SHARE_ROOM_SALT}|${secretB64}`));
  return toHex(digest).slice(0, 32);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Op signing (Act 3: authenticity + the basis for write-side RBAC)
   ──────────────────────────────────────────────────────
   A dumb E2E relay cannot enforce who may write — anyone with the share key
   can PUT ciphertext. So authenticity is established cryptographically: every
   actor holds an ECDSA P-256 keypair, signs each op, and peers verify the
   signature before admitting the op (see collab.ts for the role policy). This
   means a compromised/malicious relay can withhold or reorder blobs but can
   never FORGE or TAMPER WITH an edit. P-256 is chosen over Ed25519 for
   universal WebCrypto support (incl. older WebKitGTK in the Tauri webview).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const SIGN_ALGO = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

export interface SigningKeypair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

/** Generate a fresh signing identity. The private key is exportable so it can
 *  be persisted in the OS keychain (see oplogStore wiring); the public key is
 *  published in the share roster to bind an actor id to a verification key. */
export async function generateSigningKeypair(): Promise<SigningKeypair> {
  const kp = (await subtle().generateKey(SIGN_ALGO, true, ['sign', 'verify'])) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicKey: kp.publicKey };
}

/** Export a public key as base64 (raw uncompressed point) — what goes in the roster. */
export async function exportPublicKey(pub: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await subtle().exportKey('raw', pub)));
}
/** Import a roster public key for verification only. */
export async function importPublicKey(b64: string): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(fromB64(b64)), SIGN_ALGO, true, ['verify']);
}
/** Export a private key as base64 (pkcs8) for keychain persistence. */
export async function exportPrivateKey(priv: CryptoKey): Promise<string> {
  return toB64(new Uint8Array(await subtle().exportKey('pkcs8', priv)));
}
/** Import a persisted private key (non-extractable) for signing. */
export async function importPrivateKey(b64: string): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', buf(fromB64(b64)), SIGN_ALGO, false, ['sign']);
}

/** Sign arbitrary bytes; returns a base64 signature. */
export async function signBytes(priv: CryptoKey, data: Uint8Array): Promise<string> {
  return toB64(new Uint8Array(await subtle().sign(SIGN_PARAMS, priv, buf(data))));
}
/** Verify a base64 signature over bytes. Never throws — returns false on any error. */
export async function verifyBytes(pub: CryptoKey, sig: string, data: Uint8Array): Promise<boolean> {
  try {
    return await subtle().verify(SIGN_PARAMS, pub, buf(fromB64(sig)), buf(data));
  } catch {
    return false;
  }
}
