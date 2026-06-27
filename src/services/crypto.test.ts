import { describe, it, expect } from 'vitest';
import { deriveKey, deriveRoomId, seal, open, type SealedBlob } from './crypto';

describe('E2E crypto', () => {
  it('round-trips a value through seal → open with the same passphrase', async () => {
    const key = await deriveKey('correct horse battery staple');
    const value = { ops: [{ id: 'x', secret: 'plan the surprise party' }], n: 42 };
    const blob = await seal(key, value);
    expect(await open(key, blob)).toEqual(value);
  });

  it('fails to decrypt with the wrong passphrase', async () => {
    const blob = await seal(await deriveKey('passphrase-A'), { hello: 'world' });
    const wrong = await deriveKey('passphrase-B');
    await expect(open(wrong, blob)).rejects.toThrow(/Decryption failed/);
  });

  it('produces ciphertext that does not leak the plaintext', async () => {
    const key = await deriveKey('s3cret');
    const blob = await seal(key, { note: 'TOPSECRETMARKER' });
    const serialized = JSON.stringify(blob);
    expect(serialized).not.toContain('TOPSECRETMARKER');
    expect(serialized).not.toContain('note');
  });

  it('uses a fresh nonce each time (no deterministic ciphertext)', async () => {
    const key = await deriveKey('s3cret');
    const a = await seal(key, { x: 1 });
    const b = await seal(key, { x: 1 });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
  });

  it('detects tampering (GCM auth) ', async () => {
    const key = await deriveKey('s3cret');
    const blob = await seal(key, { x: 1 });
    const tampered: SealedBlob = { ...blob, ct: blob.ct.slice(0, -4) + (blob.ct.endsWith('A') ? 'B' : 'A') + blob.ct.slice(-3) };
    await expect(open(key, tampered)).rejects.toThrow();
  });

  it('derives a stable room id per passphrase, distinct across passphrases', async () => {
    const r1 = await deriveRoomId('team-alpha-passphrase');
    const r2 = await deriveRoomId('team-alpha-passphrase');
    const r3 = await deriveRoomId('different-passphrase');
    expect(r1).toBe(r2);
    expect(r1).not.toBe(r3);
    expect(r1).toMatch(/^[0-9a-f]{32}$/);
  });
});
