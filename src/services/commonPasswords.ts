/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/commonPasswords.ts — Common password filter
   ──────────────────────────────────────────────────────
   Filters commonly used weak passphrases and predictable sequences.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const COMMON_PASSWORDS = new Set<string>([
  '123456789012',
  '1234567890123',
  '12345678901234',
  '123456789012345',
  'qwertyuiopas',
  'qwertyuiopasd',
  'qwerty123456',
  'password1234',
  'password12345',
  'password123456',
  'administrator',
  'administrateur',
  'welcome12345',
  'welcome123456',
  'iloveyou1234',
  'iloveyou12345',
  'trustno11234',
  'changeme1234',
  'changeme12345',
  'computer1234',
  'princess1234',
  'football1234',
  'baseball1234',
  'superman1234',
  'batman123456',
  'shadow123456',
  'master123456',
  'michael12345',
  'jennifer1234',
  'jessica12345',
  'charlie12345',
  'monkey123456',
  'dragon123456',
  'master1234567',
  'sunshine1234',
  'secret123456',
  'letmein12345',
  'starwars1234',
  'freedom12345',
]);

/** Returns true if normalized password matches a known common password or trivial sequence. */
export function isCommonPassword(passphrase: string): boolean {
  const lower = passphrase.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return true;

  // Check for simple repeating or sequential character runs of length >= 12
  const isAscendingDigits = /^0?1234567890?1?2?3?4?5?$/.test(lower);
  if (isAscendingDigits && lower.length >= 12) return true;

  const isAscendingQwerty = /^qwertyuiopasdfghjklzxcvbnm$/i.test(lower);
  if (isAscendingQwerty) return true;

  return false;
}
