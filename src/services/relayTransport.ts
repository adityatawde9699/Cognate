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

import { IS_TAURI,getSetting } from '../db';

import {getSecret} from '../utils/secrets';

const TOKEN_KEY = 'sync_relay_token';

/** Optional bearer token for a gated relay (shared by workspace + share sync).
 *  It is NOT a decryption key — the relay still only ever sees ciphertext. */
async function relayToken(url:string): Promise<string> {
  const configured=await getSetting('sync_relay_url','');
  if(!configured || new URL(url).origin!==new URL(configured).origin) return '';
  return (await getSecret(TOKEN_KEY)) || '';
}
export function validateRelayUrl(value:string):void {
  const url=new URL(value);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:' && !(url.protocol==='http:' && loopback)) || url.username || url.password || url.hash) throw new Error('Use HTTPS for the relay, or HTTP on loopback for local development.');
}

export async function httpGet(url: string): Promise<string> {
  validateRelayUrl(url);
  const token = await relayToken(url);
  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('relay_fetch', { method: 'GET', url, body: null, token });
  }
  const r = await fetch(url, {signal:AbortSignal.timeout(35000),redirect:'error', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!r.ok) throw new Error(`Relay returned ${r.status}`);
  return r.text();
}

export async function httpPut(url: string, body: string): Promise<string> {
  validateRelayUrl(url);
  const token = await relayToken(url);
  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('relay_fetch', { method: 'PUT', url, body, token });
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { method: 'PUT', headers, body,signal:AbortSignal.timeout(35000),redirect:'error' });
  if (!r.ok) throw new Error(`Relay returned ${r.status}`);
  return r.text();
}

export const blobsUrl = (base: string, room: string): string => `${base}/rooms/${room}/blobs`;
