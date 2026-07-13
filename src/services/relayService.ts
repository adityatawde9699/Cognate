/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/relayService.ts — live sync over a dumb E2E relay (Act 2)
   ──────────────────────────────────────────────────────
   Turns the manual sync bundle into automatic sync. Each device seals its
   op-log with the workspace key and PUTs it to the relay under its actor id;
   pulling fetches every device's sealed blob, decrypts locally, merges
   (conflict-free), and reconciles into SQLite. The relay only ever holds an
   opaque room id and ciphertext — it cannot read or merge anything.

   Transport: the Rust `relay_fetch` command on desktop (no CORS limits,
   self-hostable), `fetch` in the browser.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting, setSetting, loadOps } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { deriveKey, deriveRoomId, seal, open, type SealedBlob } from './crypto';
import { ingestOps, actorId } from './oplogStore';
import { reconcileIntoApp } from './syncService';
import { httpGet, httpPut, blobsUrl } from './relayTransport';
import type { Op } from './oplog';

const URL_KEY = 'sync_relay_url';
const PASS_SECRET = 'sync_passphrase';

export interface RelayConfig { url: string; passphrase: string; }
export interface SyncResult { pushed: number; pulledBlobs: number; mergedOps: number; upserts: number; deletes: number; }

// A stored blob is the sealed payload plus the actor that owns it.
interface RelayBlob extends SealedBlob { actor: string; }

// ── Configuration (URL in settings, passphrase in the OS keychain) ──

export async function enableSync(url: string, passphrase: string): Promise<void> {
  await setSetting(URL_KEY, url.trim().replace(/\/$/, ''));
  await setSecret(PASS_SECRET, passphrase);
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

/** Seal this device's full op-log and upload it under our actor id. */
export async function pushLocal(cfg: RelayConfig, key: CryptoKey, room: string): Promise<number> {
  const ops = await loadOps();
  const sealed = await seal(key, ops);
  const actor = await actorId();
  await httpPut(`${blobsUrl(cfg.url, room)}/${actor}`, JSON.stringify(sealed));
  return ops.length;
}

/** Fetch every device's sealed blob, decrypt, merge, and reconcile. */
export async function pullRemote(
  cfg: RelayConfig,
  key: CryptoKey,
  room: string
): Promise<{ pulledBlobs: number; mergedOps: number; upserts: number; deletes: number }> {
  const raw = await httpGet(blobsUrl(cfg.url, room));
  const parsed = JSON.parse(raw);
  const blobs: RelayBlob[] = Array.isArray(parsed) ? parsed : parsed.blobs ?? [];
  const me = await actorId();

  const incoming: Op[] = [];
  for (const blob of blobs) {
    if (blob.actor === me) continue; // our own blob — nothing new
    try {
      incoming.push(...(await open<Op[]>(key, blob)));
    } catch (e) {
      // A blob we can't decrypt isn't ours to read; skip it rather than fail the sync.
      console.warn('[relay] skipped an undecryptable blob:', e);
    }
  }
  const mergedOps = await ingestOps(incoming);
  const { upserts, deletes } = await reconcileIntoApp();
  return { pulledBlobs: blobs.length, mergedOps, upserts, deletes };
}

/** One full sync round-trip: push our state, then pull and merge everyone else's. */
export async function syncNow(): Promise<SyncResult> {
  const cfg = await getConfig();
  if (!cfg) throw new Error('Sync is not set up. Add a relay URL and passphrase in Settings.');
  const key = await deriveKey(cfg.passphrase);
  // Room is derived from the passphrase alone — every device that shares the
  // same passphrase lands in the same room. This is intentional: it's how
  // personal multi-device sync works. Anyone with the passphrase can read
  // and merge ops (but the relay itself never can — it only sees ciphertext).
  const room = await deriveRoomId(cfg.passphrase);

  const pushed = await pushLocal(cfg, key, room);
  const pulled = await pullRemote(cfg, key, room);
  return { pushed, ...pulled };
}
