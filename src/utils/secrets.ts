/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/utils/secrets.ts — Secret storage
   In the desktop app, secrets (API key, webhook URLs) live in
   the OS keychain via the Rust `secret_get` / `secret_set`
   commands. Browser values are AES-GCM ciphertext backed by a non-exportable IndexedDB device key.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import {redactLegacySecret} from '../services/browserStorage';
import { encryptBrowserSecret,decryptBrowserSecret,isEncryptedSecret } from './browserVault';
import { getSetting, setSetting, IS_TAURI } from '../db';


const cleaned=new Set<string>();

/** Read a secret. Returns '' when unset. */
export async function getSecret(key: string): Promise<string> {
  if (IS_TAURI) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const val = await invoke<string | null>('secret_get', { key });
      return val ?? '';
    } catch (e) {
      console.warn('[secrets] Secure storage read failed:',e);
      throw new Error('Secure storage is unavailable. Unlock your system keychain and retry.');
    }
  }
  const value=await getSetting(key,'');
  if(value && !isEncryptedSecret(value) && typeof window!=='undefined') {await setSetting(key,await encryptBrowserSecret(value));}
  const plain=await decryptBrowserSecret(value);
  if(plain && typeof window!=='undefined' && !cleaned.has(key)) {await redactLegacySecret(key);cleaned.add(key);}
  return plain;
}

/** Write a secret (empty string clears it). */
export async function setSecret(key: string, value: string): Promise<void> {
  if (IS_TAURI) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('secret_set', { key, value });
      return;
    } catch (e) {
      console.warn('[secrets] Secure storage write failed:',e);
      throw new Error('Secret was not saved: secure storage is unavailable. Unlock your system keychain and retry.');
    }
  }
  await setSetting(key, await encryptBrowserSecret(value));
}

/**
 * One-time migration: move any legacy plaintext secrets out of the
 * `app_state` table into the keychain, then blank the plaintext copy.
 * Safe to call on every startup — it no-ops once migrated.
 */
export async function migrateSecrets(): Promise<void> {

  const keys = ['ai_api_key', 'int_slack', 'int_discord', 'sync_passphrase', 'crdt_signing_key', 'cal_oauth_tokens','sync_relay_token','cal_oauth_pending','calendar_ics_feed'];
  const shares=JSON.parse((await getSetting('shares_v1','[]')) || '[]');
  for(const share of shares) keys.push(`share_secret_${share.id}`);
  for (const key of keys) {
    try {
      const legacy = await getSetting(key, '');
      if (!legacy) continue;
      if(!IS_TAURI) {await getSecret(key);continue;}
      const existing = await getSecret(key);
      if (!existing) await setSecret(key, legacy);
      if (await getSecret(key) !== (existing || legacy)) throw new Error('Keychain migration verification failed.');
      await setSetting(key, ''); // clear plaintext
    } catch (e) {
      console.warn('[secrets] migration failed for', key, e);
    }
  }
}
