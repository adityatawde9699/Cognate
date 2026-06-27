/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/presenceService.ts — who's here (Act 3)
   ──────────────────────────────────────────────────────
   Presence is ephemeral, so it lives OUTSIDE the durable op-log: each device
   PUTs a tiny sealed heartbeat {actor, at} to a SEPARATE relay room derived
   from the share secret (so a data pull never trips over presence blobs, and
   the relay still sees only ciphertext). A peer counts as "online" if its
   heartbeat is recent. Best-effort throughout — presence never blocks data.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { importShareKey, roomIdForSecret, seal, open, type SealedBlob } from './crypto';
import { actorId } from './oplogStore';
import { httpGet, httpPut, blobsUrl } from './relayTransport';
import type { Share } from './shareService';

// Online window must exceed the heartbeat cadence so peers don't flicker.
const ONLINE_MS = 5 * 60 * 1000;

interface Beat { actor: string; at: number }
export interface Presence { actor: string; at: number; online: boolean }

/** A presence room distinct from the share's data room (same key, +salt). */
const presenceRoom = (secret: string) => roomIdForSecret(`${secret}|presence`);

/** Announce that we're here, now. */
export async function heartbeat(share: Share): Promise<void> {
  if (!share.url) return;
  const me = await actorId();
  const key = await importShareKey(share.secret);
  const room = await presenceRoom(share.secret);
  const sealed = await seal(key, { actor: me, at: Date.now() } satisfies Beat);
  await httpPut(`${blobsUrl(share.url, room)}/${me}`, JSON.stringify(sealed));
}

/** Read everyone's last heartbeat and flag who's currently online. */
export async function getPresence(share: Share): Promise<Presence[]> {
  if (!share.url) return [];
  const key = await importShareKey(share.secret);
  const room = await presenceRoom(share.secret);
  const raw = await httpGet(blobsUrl(share.url, room));
  const parsed = JSON.parse(raw);
  const blobs: (SealedBlob & { actor?: string })[] = Array.isArray(parsed) ? parsed : parsed.blobs ?? [];

  const now = Date.now();
  const out: Presence[] = [];
  for (const blob of blobs) {
    try {
      const b = await open<Beat>(key, blob);
      out.push({ actor: b.actor, at: b.at, online: now - b.at < ONLINE_MS });
    } catch {
      // Not ours to read (different key) — skip.
    }
  }
  return out;
}
