/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/utils/secrets.ts — Secret storage
   In the desktop app, secrets (API key, webhook URLs) live in
   the OS keychain via the Rust `secret_get` / `secret_set`
   commands. In the browser they fall back to the same
   localStorage-backed settings store so dev still works.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting, setSetting } from '../db';

const IS_TAURI = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

/** Read a secret. Returns '' when unset. */
export async function getSecret(key: string): Promise<string> {
  if (IS_TAURI) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const val = await invoke<string | null>('secret_get', { key });
      return val ?? '';
    } catch (e) {
      console.warn('[secrets] keychain read failed, falling back:', e);
    }
  }
  return getSetting(key, '');
}

/** Write a secret (empty string clears it). */
export async function setSecret(key: string, value: string): Promise<void> {
  if (IS_TAURI) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secret_set', { key, value });
      return;
    } catch (e) {
      console.warn('[secrets] keychain write failed, falling back:', e);
    }
  }
  await setSetting(key, value);
}

/**
 * One-time migration: move any legacy plaintext secrets out of the
 * `app_state` table into the keychain, then blank the plaintext copy.
 * Safe to call on every startup — it no-ops once migrated.
 */
export async function migrateSecrets(): Promise<void> {
  if (!IS_TAURI) return;
  const keys = ['ai_api_key', 'int_slack', 'int_discord'];
  for (const key of keys) {
    try {
      const legacy = await getSetting(key, '');
      if (!legacy) continue;
      const existing = await getSecret(key);
      if (!existing) await setSecret(key, legacy);
      await setSetting(key, ''); // clear plaintext
    } catch (e) {
      console.warn('[secrets] migration failed for', key, e);
    }
  }
}
