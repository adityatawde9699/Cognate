#!/usr/bin/env node
/**
 * scripts/verify_kat.mjs
 * Independent verification of Known-Answer Test (KAT) vectors for Cognate Sync v3.
 * Uses ONLY node:crypto. Does NOT import any application code.
 * Recomputes M, K_v3, R_v3, C_v3 and the Section 3.3 AES-GCM ciphertext.
 */

import crypto from 'node:crypto';

console.log('Verifying Cognate Sync v3 KAT with node:crypto...');

// Inputs from Section 3.3
const passphrase = 'correct horse battery staple';
const setupCode = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

// Canonical normalization: NFKD, trimmed
const normalizedPass = Buffer.from(passphrase.normalize('NFKD').trim(), 'utf8');

// Salt: "cognate-v3:" (11 bytes) || 0x10 (1 byte) || setupCode (16 bytes) = 28 bytes
const salt = Buffer.concat([
  Buffer.from('cognate-v3:', 'utf8'),
  Buffer.from([0x10]),
  setupCode,
]);

if (salt.length !== 28) {
  throw new Error(`Invalid salt length: ${salt.length}, expected 28`);
}

// 1. Master Secret (M): PBKDF2-SHA256 (600,000 iters, 32 bytes)
const masterSecret = crypto.pbkdf2Sync(normalizedPass, salt, 600000, 32, 'sha256');
const expectedM = '64d28da6b43e213c1479ac959aa8761c20156c179b669514f7fa7b76c2ecf288';
if (masterSecret.toString('hex') !== expectedM) {
  console.error(`Master secret mismatch!\nExpected: ${expectedM}\nGot:      ${masterSecret.toString('hex')}`);
  process.exit(1);
}
console.log(`Master Secret (M):  ${masterSecret.toString('hex')} (MATCH)`);

// 2. K_v3 (32 bytes AES-256 key via HKDF-SHA256)
const zeroSalt = Buffer.alloc(0);
const kV3 = Buffer.from(crypto.hkdfSync('sha256', masterSecret, zeroSalt, Buffer.from('cognate-sync-key-v3', 'utf8'), 32));
const expectedK = 'b9b73b7fb6a7389e1c94186de6f63d25ee217ff76e135678951af4947db15057';
if (kV3.toString('hex') !== expectedK) {
  console.error(`K_v3 mismatch!\nExpected: ${expectedK}\nGot:      ${kV3.toString('hex')}`);
  process.exit(1);
}
console.log(`AES Key (K_v3):     ${kV3.toString('hex')} (MATCH)`);

// 3. R_v3 (32 bytes expanded, first 16 bytes = 32 hex chars)
const rV3Full = Buffer.from(crypto.hkdfSync('sha256', masterSecret, zeroSalt, Buffer.from('cognate-sync-room-v3', 'utf8'), 32));
const rV3 = rV3Full.subarray(0, 16);
const expectedR = 'af340eac1d2451afe20f762a4a8cb695';
if (rV3.toString('hex') !== expectedR) {
  console.error(`R_v3 mismatch!\nExpected: ${expectedR}\nGot:      ${rV3.toString('hex')}`);
  process.exit(1);
}
console.log(`Room ID (R_v3):     ${rV3.toString('hex')} (MATCH)`);

// 4. C_v3 (16 bytes = 32 hex chars)
const cV3 = Buffer.from(crypto.hkdfSync('sha256', masterSecret, zeroSalt, Buffer.from('cognate-sync-verifier-v3', 'utf8'), 16));
const expectedC = '3cf82af26a2bdad2b0e0aa78f6bb1166';
if (cV3.toString('hex') !== expectedC) {
  console.error(`C_v3 mismatch!\nExpected: ${expectedC}\nGot:      ${cV3.toString('hex')}`);
  process.exit(1);
}
console.log(`Verifier (C_v3):    ${cV3.toString('hex')} (MATCH)`);

// 5. AES-256-GCM sample encryption with 12 zero bytes IV and plaintext {"genesis":true}
const iv = Buffer.alloc(12);
const plaintext = Buffer.from('{"genesis":true}', 'utf8');
const cipher = crypto.createCipheriv('aes-256-gcm', kV3, iv);
const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();

const expectedCt = '0e2209e87b9dcb2fa8d6ed3bc8aaa7be';
const expectedTag = 'd8dc956bb905c44e6e95319a97953397';

if (ct.toString('hex') !== expectedCt) {
  console.error(`Ciphertext mismatch!\nExpected: ${expectedCt}\nGot:      ${ct.toString('hex')}`);
  process.exit(1);
}
if (tag.toString('hex') !== expectedTag) {
  console.error(`Auth tag mismatch!\nExpected: ${expectedTag}\nGot:      ${tag.toString('hex')}`);
  process.exit(1);
}

console.log(`AES-GCM CT:         ${ct.toString('hex')} (MATCH)`);
console.log(`AES-GCM Tag:        ${tag.toString('hex')} (MATCH)`);
console.log('\nAll node:crypto independent KAT checks: PASS');
