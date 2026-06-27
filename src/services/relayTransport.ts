/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/relayTransport.ts — HTTP transport to the dumb E2E relay
   ──────────────────────────────────────────────────────
   Shared by workspace sync (relayService, Act 2) and per-share sync
   (shareService, Act 3). The relay only ever holds an opaque room id and
   sealed blobs, so the transport is intentionally tiny: PUT a blob under
   {room}/{actor}, GET all blobs in a room. On desktop it routes through the
   Rust `relay_fetch` command (no CORS, self-hostable); in the browser it uses
   fetch. Identical contract either way.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { IS_TAURI, getSetting } from '../db';

const TOKEN_KEY = 'sync_relay_token';

/** Optional bearer token for a gated relay (shared by workspace + share sync).
 *  It is NOT a decryption key — the relay still only ever sees ciphertext. */
async function relayToken(): Promise<string> {
  return (await getSetting(TOKEN_KEY, '')) || '';
}

export async function httpGet(url: string): Promise<string> {
  const token = await relayToken();
  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('relay_fetch', { method: 'GET', url, body: null, token });
  }
  const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`Relay returned ${r.status}`);
  return r.text();
}

export async function httpPut(url: string, body: string): Promise<string> {
  const token = await relayToken();
  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('relay_fetch', { method: 'PUT', url, body, token });
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { method: 'PUT', headers, body });
  if (!r.ok) throw new Error(`Relay returned ${r.status}`);
  return r.text();
}

export const blobsUrl = (base: string, room: string): string => `${base}/rooms/${room}/blobs`;
