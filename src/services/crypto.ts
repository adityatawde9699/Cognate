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

import { isCommonPassword } from './commonPasswords';

const PBKDF2_ITERS = 150_000;
const KEY_SALT = 'cognate-sync-key-v1';

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
 * The versioned, slow KDF prevents a fast room-ID password dictionary check.
 * Room IDs and ciphertext still permit guessing; use a strong passphrase.
 */
export async function deriveRoomId(passphrase: string): Promise<string> {
  const base=await subtle().importKey('raw',enc.encode(passphrase),'PBKDF2',false,['deriveBits']);
  const digest=await subtle().deriveBits({name:'PBKDF2',salt:enc.encode('cognate-sync-room-v2'),iterations:600000,hash:'SHA-256'},base,256);
  return toHex(digest).slice(0,32);
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

/** Password-protected portable exports use a random salt and explicit KDF
 * version. Legacy v1 ciphertext remains readable, never generated here. */
export interface PasswordBlob {v:2;kdf:{name:'PBKDF2-SHA256';iterations:600000;salt:string};sealed:SealedBlob}
async function passwordKey(passphrase:string,salt:string):Promise<CryptoKey> {
  const raw=fromB64(salt);
  if(raw.length!==16) throw new Error('Invalid password-export salt.');
  const base=await subtle().importKey('raw',enc.encode(passphrase),'PBKDF2',false,['deriveKey']);
  return subtle().deriveKey({name:'PBKDF2',salt:buf(raw),iterations:600000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function sealPassword(passphrase:string,value:unknown):Promise<PasswordBlob> {
  if(passphrase.length<12) throw new Error('Use a recovery passphrase of at least 12 characters.');
  const salt=toB64(randomBytes(16));
  return {v:2,kdf:{name:'PBKDF2-SHA256',iterations:600000,salt},sealed:await seal(await passwordKey(passphrase,salt),value)};
}
export async function openPassword<T>(passphrase:string,blob:PasswordBlob|SealedBlob):Promise<T> {
  if(blob.v===1) return open<T>(await deriveKey(passphrase),blob);
  if(blob.v!==2 || blob.kdf?.name!=='PBKDF2-SHA256' || blob.kdf.iterations!==600000) throw new Error('Unsupported recovery encryption version.');
  return open<T>(await passwordKey(passphrase,blob.kdf.salt),blob.sealed);
}

export async function deriveSyncKey(passphrase:string):Promise<CryptoKey> {
  const base=await subtle().importKey('raw',enc.encode(passphrase),'PBKDF2',false,['deriveKey']);
  return subtle().deriveKey({name:'PBKDF2',salt:enc.encode('cognate-sync-key-v2'),iterations:600000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Sync Protocol v3 (Act 3.2: single PBKDF2 + HKDF-SHA256, Setup Code, & Soft-Delete)
   ──────────────────────────────────────────────────────
   - 128-bit random Setup Code S encoded via Crockford Base32 + Modulo-32 checksum.
   - Single PBKDF2 stretches normalized passphrase + salt ("cognate-v3:" || 0x10 || S)
     into Master Secret M (256-bit PRK).
   - HKDF-Expand derives K_v3 (data key), R_v3 (room id), and C_v3 (genesis verifier).
   - Random delete token T_del registered as SHA-256(T_del) allows authorized soft-delete.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CROCKFORD_MAP = new Map<string, number>();
for (let i = 0; i < CROCKFORD_ALPHABET.length; i++) {
  CROCKFORD_MAP.set(CROCKFORD_ALPHABET[i], i);
}

/** Mint 16 cryptographically random bytes for a v3 Setup Code. */
export function generateSetupCode(): Uint8Array {
  return randomBytes(16);
}

/**
 * Compute CRC-5 checksum over 130 bits (128 data bits + 2 zero pad bits).
 * Polynomial: x^5 + x^2 + 1 (binary 100101, normal representation 0x05).
 * Initial value: 0, final XOR: 0.
 * Output: integer in [0, 31].
 */
export function crc5(digits26: number[]): number {
  let crc = 0;
  for (let i = 0; i < 26; i++) {
    const d = digits26[i];
    for (let bitIdx = 4; bitIdx >= 0; bitIdx--) {
      const b = (d >> bitIdx) & 1;
      const feedback = ((crc >> 4) ^ b) & 1;
      crc = ((crc << 1) & 0x1f) ^ (feedback ? 0x05 : 0);
    }
  }
  return crc;
}

/**
 * Encode 16 raw bytes into Crockford Base32 with a CRC-5 check symbol.
 * Output format: 4-4-4-4-4-4-3 (27 characters + 6 hyphens).
 */
export function encodeSetupCode(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('Expected 16 raw bytes for Setup Code.');
  const digits: number[] = [];
  let buffer = 0;
  let bitsLeft = 0;
  for (let i = 0; i < 16; i++) {
    buffer = (buffer << 8) | bytes[i];
    bitsLeft += 8;
    while (bitsLeft >= 5) {
      bitsLeft -= 5;
      digits.push((buffer >> bitsLeft) & 0x1f);
    }
  }
  if (bitsLeft > 0) {
    digits.push((buffer << (5 - bitsLeft)) & 0x1f);
  }
  const check = crc5(digits);
  const raw = digits.map((d) => CROCKFORD_ALPHABET[d]).join('') + CROCKFORD_ALPHABET[check];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 24)}-${raw.slice(24, 27)}`;
}

/**
 * Decode a Crockford Base32 Setup Code into 16 raw bytes.
 * Validates length (27 chars), alphabet, CRC-5 check symbol, and zero pad bits.
 * Supports lowercase, strips hyphens/whitespace, and maps O->0, I/L->1.
 * Rejects U/u and non-canonical pad bits.
 */
export function decodeSetupCode(code: string): Uint8Array {
  if (typeof code !== 'string') throw new Error('Invalid Setup Code: string expected');
  const cleaned = code.replace(/[-\s]/g, '').toUpperCase();
  if (cleaned.includes('U')) throw new Error('Invalid character: U is not allowed in Setup Code');
  if (cleaned.length !== 27) throw new Error('Invalid Setup Code length: expected 27 characters');

  const digits: number[] = [];
  for (let i = 0; i < 27; i++) {
    let ch = cleaned[i];
    if (ch === 'O') ch = '0';
    else if (ch === 'I' || ch === 'L') ch = '1';
    const val = CROCKFORD_MAP.get(ch);
    if (val === undefined) throw new Error(`Invalid Setup Code character: ${ch}`);
    digits.push(val);
  }

  if ((digits[25] & 0x03) !== 0) {
    throw new Error('Invalid Setup Code padding: non-canonical non-zero pad bits');
  }

  const expectedCrc = crc5(digits.slice(0, 26));
  if (expectedCrc !== digits[26]) {
    throw new Error('Invalid Setup Code checksum');
  }

  const bytes = new Uint8Array(16);
  let buffer = 0;
  let bitsLeft = 0;
  let byteIndex = 0;

  for (let i = 0; i < 26; i++) {
    const d = digits[i];
    if (i === 25) {
      buffer = (buffer << 3) | (d >> 2);
      bitsLeft += 3;
    } else {
      buffer = (buffer << 5) | d;
      bitsLeft += 5;
    }
    while (bitsLeft >= 8 && byteIndex < 16) {
      bitsLeft -= 8;
      bytes[byteIndex++] = (buffer >> bitsLeft) & 0xff;
    }
  }

  return bytes;
}

/**
 * Validates a v3 passphrase according to Section 4.1:
 * - NFKD normalized and trimmed
 * - >= 12 Unicode scalar values
 * - >= 4 unique code points
 * - Not a commonly used password
 */
export function validatePassphrase(passphrase: string): { valid: boolean; error?: string } {
  if (typeof passphrase !== 'string') {
    return { valid: false, error: 'Passphrase must be a string' };
  }
  const normalized = passphrase.normalize('NFKD').trim();
  const scalarCount = [...normalized].length;
  if (scalarCount < 12) {
    return { valid: false, error: 'Passphrase must contain at least 12 characters' };
  }
  const uniqueCodePoints = new Set([...normalized]).size;
  if (uniqueCodePoints < 4) {
    return { valid: false, error: 'Passphrase must contain at least 4 unique characters' };
  }
  if (isCommonPassword(normalized)) {
    return { valid: false, error: 'Passphrase is a commonly used password' };
  }
  return { valid: true };
}

export interface SyncCredentialsV3 {
  masterSecret: Uint8Array;
  key: CryptoKey;
  keyBytes: Uint8Array;
  room: string;
  verifier: string;
}

/**
 * Derive v3 sync credentials (K_v3, R_v3, C_v3) from passphrase and Setup Code.
 * Single PBKDF2 (600,000 iters) + HKDF-SHA256 expansions (Section 3).
 */
export async function deriveSyncV3(passphrase: string, setupCode: Uint8Array): Promise<SyncCredentialsV3> {
  const check = validatePassphrase(passphrase);
  if (!check.valid) throw new Error(check.error);
  if (setupCode.length !== 16) throw new Error('Setup code must be 16 bytes');

  const normalized = passphrase.normalize('NFKD').trim();
  // Salt: "cognate-v3:" (11 bytes) || 0x10 (1 byte) || setupCode (16 bytes) = 28 bytes
  const salt = new Uint8Array(28);
  salt.set(enc.encode('cognate-v3:'), 0);
  salt[11] = 0x10;
  salt.set(setupCode, 12);

  const base = await subtle().importKey('raw', enc.encode(normalized), 'PBKDF2', false, ['deriveBits']);
  const mBits = await subtle().deriveBits(
    { name: 'PBKDF2', salt: buf(salt), iterations: 600000, hash: 'SHA-256' },
    base,
    256
  );
  const masterSecret = new Uint8Array(mBits);

  const hkdfKey = await subtle().importKey('raw', buf(masterSecret), 'HKDF', false, ['deriveBits', 'deriveKey']);
  const zeroSalt = new Uint8Array(0);

  const keyBits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(zeroSalt), info: enc.encode('cognate-sync-key-v3') },
    hkdfKey,
    256
  );
  const keyBytes = new Uint8Array(keyBits);
  const key = await subtle().importKey('raw', buf(keyBytes), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

  const roomBits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(zeroSalt), info: enc.encode('cognate-sync-room-v3') },
    hkdfKey,
    256
  );
  const room = toHex(roomBits).slice(0, 32);

  const verifierBits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(zeroSalt), info: enc.encode('cognate-sync-verifier-v3') },
    hkdfKey,
    128
  );
  const verifier = toHex(verifierBits);

  return {
    masterSecret,
    key,
    keyBytes,
    room,
    verifier,
  };
}

/** Mint 16 random bytes as a 32-character hex delete token T_del. */
export function generateDeleteToken(): string {
  return toHex(buf(randomBytes(16)));
}

/** Compute SHA-256 hash of delete token as a 64-character hex string for X-Delete-Token-Hash. */
export async function hashDeleteToken(token: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(token));
  return toHex(digest);
}

