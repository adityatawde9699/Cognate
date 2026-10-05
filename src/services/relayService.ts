/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/relayService.ts — live sync over a dumb E2E relay (Act 2)
   ──────────────────────────────────────────────────────
   Uploads immutable signed operation batches with durable acknowledgements.
   A saved ciphertext outbox retries exactly after outages; admitted projection
   commits precede cursor advancement. The relay holds only opaque ciphertext.

   Transport: the Rust `relay_fetch` command on desktop (no CORS limits,
   self-hostable), `fetch` in the browser.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting, setSetting, loadOps } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { deriveSyncKey, deriveRoomId } from './crypto';
import { mergeIntoApp } from './syncService';
import {validateRelayUrl} from './relayTransport';
import { pushBatches, pullBatches, withSyncLock,checkRetryWindow } from './batchSync';

const URL_KEY = 'sync_relay_url';
const PASS_SECRET = 'sync_passphrase';

export interface RelayConfig { url: string; passphrase: string; }
export interface SyncResult { pushed: number; pulledBlobs: number; mergedOps: number; upserts: number; deletes: number; }


// ── Configuration (URL in settings, passphrase in the OS keychain) ──

export async function enableSync(url: string, passphrase: string): Promise<void> {
  validateRelayUrl(url.trim());
  if(new URL(url.trim()).search) throw new Error('Relay base URL cannot contain a query.');
  const current=await getConfig(),nextUrl=url.trim().replace(/\/$/,'');
  if(current && (current.passphrase!==passphrase || current.url!==nextUrl)) throw new Error('Changing an active workspace key or relay requires an explicit migration. Export a verified recovery kit and operation bundle first; reconnect with the existing configuration.');
  const bindingRaw=await getSetting('sync_workspace_binding','');
  if(!current && bindingRaw && (await loadOps()).length) {
    const binding=JSON.parse(bindingRaw);
    if(binding.url!==nextUrl || binding.room!==await deriveRoomId(passphrase)) throw new Error('This workspace is bound to its previous sync configuration. Use an explicit migration before changing its key or relay.');
  }
  await setSetting(URL_KEY, url.trim().replace(/\/$/, ''));
  await setSecret(PASS_SECRET, passphrase);
  if(!bindingRaw) await setSetting('sync_workspace_binding',JSON.stringify({url:nextUrl,room:await deriveRoomId(passphrase)}));
}
export async function disableSync(): Promise<void> {
  await setSetting(URL_KEY, '');
  await setSecret(PASS_SECRET, '');
}
export async function getConfig(): Promise<RelayConfig | null> {
  const url = (await getSetting(URL_KEY, '')) || '';
  const passphrase = (await getSecret(PASS_SECRET)) || '';
  return url && passphrase ? { url, passphrase } : null;
}
export async function isSyncEnabled(): Promise<boolean> {
  return (await getConfig()) !== null;
}

// ── Push / pull / sync ───────────────────────────────────

/** V2 only: legacy whole-log rooms are retained, never silently admitted. */
export async function pushLocal(cfg: RelayConfig,key:CryptoKey,room:string):Promise<number> {
  return pushBatches({url:cfg.url,room,key,context:{kind:'workspace',id:room,epoch:1}},await loadOps());
}
export async function pullRemote(cfg:RelayConfig,key:CryptoKey,room:string) {
  const pulled=await pullBatches({url:cfg.url,room,key,context:{kind:'workspace',id:room,epoch:1}},
    async archive=>mergeIntoApp(archive.flatMap(batch=>batch.ops)));
  return {pulledBlobs:pulled.batches,mergedOps:pulled.result.applied,upserts:pulled.result.upserts,deletes:pulled.result.deletes};
}
export async function syncNow(options:{automatic?:boolean}={}):Promise<SyncResult> {
  const cfg=await getConfig();
  if(!cfg) throw new Error('Sync is not set up. Add a relay URL and passphrase in Settings.');
  const key=await deriveSyncKey(cfg.passphrase),room=await deriveRoomId(cfg.passphrase);
  if(options.automatic) await checkRetryWindow(room,cfg.url);
  return withSyncLock(room,async()=>({pushed:await pushLocal(cfg,key,room),...await pullRemote(cfg,key,room)}));
}
