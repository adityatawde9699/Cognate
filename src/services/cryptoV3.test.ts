import { describe, it, expect } from 'vitest';
import {
  encodeSetupCode,
  decodeSetupCode,
  generateSetupCode,
  validatePassphrase,
  deriveSyncV3,
  generateDeleteToken,
  hashDeleteToken,
} from './crypto';

describe('Sync Protocol v3 Cryptography & Setup Code', () => {
  describe('Setup Code Base-32 Encoding & Checksum (Section 2)', () => {
    it('matches KAT Vector 1: Zero Vector', () => {
      const bytes = new Uint8Array(16);
      const code = encodeSetupCode(bytes);
      expect(code).toBe('0000-0000-0000-0000-0000-0000-000');
      const decoded = decodeSetupCode(code);
      expect(decoded).toEqual(bytes);
    });

    it('matches KAT Vector 2: All-Ones Vector', () => {
      const bytes = new Uint8Array(16).fill(0xff);
      const code = encodeSetupCode(bytes);
      expect(code).toBe('ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZWJ');
      const decoded = decodeSetupCode(code);
      expect(decoded).toEqual(bytes);
    });

    it('matches KAT Vector 3: Sequential Vector', () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const code = encodeSetupCode(bytes);
      expect(code).toBe('0410-6105-0R3G-G28A-1C60-T3GF-20E');
      const decoded = decodeSetupCode(code);
      expect(decoded).toEqual(bytes);
    });

    it('exhaustively detects 100% of single-character substitutions across 1000 random codes', () => {
      const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let totalTests = 0;
      let detectedErrors = 0;

      for (let i = 0; i < 1000; i++) {
        const raw = generateSetupCode();
        const code = encodeSetupCode(raw);
        const chars = code.replace(/-/g, '').split('');

        // Test every single substitution: 27 positions x 31 alternative characters = 837 tests per code
        for (let pos = 0; pos < 27; pos++) {
          const originalChar = chars[pos];
          for (let c = 0; c < CROCKFORD_ALPHABET.length; c++) {
            const altChar = CROCKFORD_ALPHABET[c];
            if (altChar === originalChar) continue;
            totalTests++;
            const mutatedChars = [...chars];
            mutatedChars[pos] = altChar;
            const mutatedCode = `${mutatedChars.slice(0, 4).join('')}-${mutatedChars.slice(4, 8).join('')}-${mutatedChars.slice(8, 12).join('')}-${mutatedChars.slice(12, 16).join('')}-${mutatedChars.slice(16, 20).join('')}-${mutatedChars.slice(20, 24).join('')}-${mutatedChars.slice(24, 27).join('')}`;

            try {
              decodeSetupCode(mutatedCode);
            } catch {
              detectedErrors++;
            }
          }
        }
      }

      expect(totalTests).toBe(837000);
      expect(detectedErrors).toBe(837000);
      expect(detectedErrors / totalTests).toBe(1.0);
    });

    it('measures and verifies adjacent transposition detection rate across 1000 random codes', () => {
      let totalTranspositions = 0;
      let detectedTranspositions = 0;

      for (let i = 0; i < 1000; i++) {
        const raw = generateSetupCode();
        const code = encodeSetupCode(raw);
        const chars = code.replace(/-/g, '').split('');

        // Test all 26 adjacent pairs
        for (let pos = 0; pos < 26; pos++) {
          if (chars[pos] === chars[pos + 1]) continue;
          totalTranspositions++;
          const mutatedChars = [...chars];
          const tmp = mutatedChars[pos];
          mutatedChars[pos] = mutatedChars[pos + 1];
          mutatedChars[pos + 1] = tmp;
          const mutatedCode = `${mutatedChars.slice(0, 4).join('')}-${mutatedChars.slice(4, 8).join('')}-${mutatedChars.slice(8, 12).join('')}-${mutatedChars.slice(12, 16).join('')}-${mutatedChars.slice(16, 20).join('')}-${mutatedChars.slice(20, 24).join('')}-${mutatedChars.slice(24, 27).join('')}`;

          try {
            decodeSetupCode(mutatedCode);
          } catch {
            detectedTranspositions++;
          }
        }
      }

      // Record measured detection rate: 100.0% measured detection rate
      const rate = detectedTranspositions / totalTranspositions;
      expect(rate).toBe(1.0);
    });

    it('round-trips random setup codes', () => {
      for (let i = 0; i < 20; i++) {
        const raw = generateSetupCode();
        expect(raw.length).toBe(16);
        const encoded = encodeSetupCode(raw);
        expect(encoded).toMatch(/^[0-9A-HJKMNP-Z]{4}(-[0-9A-HJKMNP-Z]{4}){5}-[0-9A-HJKMNP-Z]{3}$/);
        const decoded = decodeSetupCode(encoded);
        expect(decoded).toEqual(raw);
      }
    });

    it('permissively decodes with lowercase, whitespace, and Crockford aliases', () => {
      // 0410-6105-0R3G-G28A-1C60-T3GF-20E
      // with o -> 0, l/i -> 1, mixed case, and spaces instead of hyphens
      const aliased = 'o4l0 6I05 0r3g g28a 1c6o t3gf 20e';
      const decoded = decodeSetupCode(aliased);
      expect(decoded).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]));
    });

    it('rejects forbidden character U/u', () => {
      expect(() => decodeSetupCode('0410-6105-0R3G-G28A-1C60-T3GF-20U')).toThrow(/U is not allowed/i);
      expect(() => decodeSetupCode('0410-6105-0R3G-G28A-1C60-T3GF-20u')).toThrow(/U is not allowed/i);
    });

    it('rejects characters not in the Crockford alphabet', () => {
      expect(() => decodeSetupCode('0410-6105-0R3G-G28A-1C60-T3GF-20@')).toThrow(/Invalid Setup Code/i);
    });

    it('detects single-character substitution errors', () => {
      // Valid: 0410-6105-0R3G-G28A-1C60-T3GF-20E
      // Mutate one character:
      const mutated = '0410-6105-0R3G-G28A-1C60-T3GF-20M';
      expect(() => decodeSetupCode(mutated)).toThrow(/checksum/i);
    });

    it('detects adjacent transposition errors', () => {
      // Valid: 0410-6105-0R3G-G28A-1C60-T3GF-20E
      // Swap first two characters: '4010-...' instead of '0410-...'
      const transposed = '4010-6105-0R3G-G28A-1C60-T3GF-20E';
      expect(() => decodeSetupCode(transposed)).toThrow(/checksum/i);
    });

    it('rejects invalid length and invalid non-zero padding', () => {
      expect(() => decodeSetupCode('0410-6105')).toThrow(/length/i);
      // Construct 27 characters with non-zero pad bits in digit 25:
      // Digit 25 with lower bits set
      const badPad = '0000-0000-0000-0000-0000-0001-000';
      expect(() => decodeSetupCode(badPad)).toThrow();
    });
  });

  describe('Passphrase Validation (Section 4)', () => {
    it('accepts strong passphrases', () => {
      expect(validatePassphrase('correct horse battery staple')).toEqual({ valid: true });
      expect(validatePassphrase('cognate-sync-2026-secure-key')).toEqual({ valid: true });
    });

    it('rejects passphrases shorter than 12 Unicode scalar values', () => {
      const res = validatePassphrase('short-pass');
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/at least 12/i);
    });

    it('rejects passphrases with fewer than 4 unique code points', () => {
      const res1 = validatePassphrase('aaaaaaaaaaaa');
      expect(res1.valid).toBe(false);
      expect(res1.error).toMatch(/at least 4 unique/i);

      const res2 = validatePassphrase('abababababab');
      expect(res2.valid).toBe(false);
      expect(res2.error).toMatch(/at least 4 unique/i);
    });

    it('rejects common passwords', () => {
      const res = validatePassphrase('123456789012');
      expect(res.valid).toBe(false);
      expect(res.error).toMatch(/common/i);
    });

    it('applies NFKD normalization and trimming', () => {
      // "  correct horse battery staple  "
      expect(validatePassphrase('   correct horse battery staple   ')).toEqual({ valid: true });
    });
  });

  describe('Single PBKDF2 + HKDF-SHA256 Derivation (Section 3)', () => {
    it('matches Section 3.3 Known-Answer Test Vector (KAT)', async () => {
      const passphrase = 'correct horse battery staple';
      const setupCode = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

      const creds = await deriveSyncV3(passphrase, setupCode);

      // Verify Master Secret (M)
      const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(toHex(creds.masterSecret)).toBe('64d28da6b43e213c1479ac959aa8761c20156c179b669514f7fa7b76c2ecf288');

      // Verify AES Key bytes
      expect(toHex(creds.keyBytes)).toBe('b9b73b7fb6a7389e1c94186de6f63d25ee217ff76e135678951af4947db15057');

      // Verify Room ID (R_v3)
      expect(creds.room).toBe('af340eac1d2451afe20f762a4a8cb695');

      // Verify Genesis Verifier (C_v3)
      expect(creds.verifier).toBe('3cf82af26a2bdad2b0e0aa78f6bb1166');

      // Verify AES-GCM sample encryption with zero IV produces KAT ciphertext and tag
      const zeroIv = new Uint8Array(12);
      const plaintext = new TextEncoder().encode(JSON.stringify({ genesis: true }));
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: zeroIv }, creds.key, plaintext);
      const encBytes = new Uint8Array(encrypted);
      const ct = encBytes.subarray(0, encBytes.length - 16);
      const tag = encBytes.subarray(encBytes.length - 16);
      expect(toHex(ct)).toBe('0e2209e87b9dcb2fa8d6ed3bc8aaa7be');
      expect(toHex(tag)).toBe('d8dc956bb905c44e6e95319a97953397');
    });

    it('rejects invalid setup code lengths or weak passphrases', async () => {
      await expect(deriveSyncV3('short', new Uint8Array(16))).rejects.toThrow();
      await expect(deriveSyncV3('correct horse battery staple', new Uint8Array(10))).rejects.toThrow();
    });
  });

  describe('Delete Token Generation and Hashing', () => {
    it('generates 32-char hex token and 64-char SHA-256 hash', async () => {
      const token = generateDeleteToken();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      const hash = await hashDeleteToken(token);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      // Deterministic hash check
      const hash2 = await hashDeleteToken(token);
      expect(hash2).toBe(hash);
    });
  });
});
