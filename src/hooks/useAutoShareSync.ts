/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/hooks/useAutoShareSync.ts (Act 3)
   Real-time-ish collaboration without websockets:
     • per share, a LONG-POLL loop holds a request on the relay until the room's
       version moves (someone wrote), then syncs immediately — edits land in
       ~a second, not minutes. The held request uses no CPU/bandwidth while idle;
     • a SLOW loop heartbeats presence and force-syncs as a safety net.
   Best-effort and offline-tolerant; polling pauses while the tab is hidden.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect } from 'react';
import {
  listShares, syncAllShares, syncShare, shareRoomPoll, getShare,
} from '../services/shareService';
import { heartbeat } from '../services/presenceService';
import { loadAllTasks } from '../services/taskService';
import { useStore } from '../store';

const SLOW_MS = 3 * 60 * 1000;     // presence heartbeat + safety-net full sync
const IDLE_BACKOFF_MS = 3 * 1000;  // pause before re-polling after no change / an error
const HIDDEN_MS = 2 * 1000;        // re-check cadence while the tab is hidden

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

async function reloadView(): Promise<void> {
  const f = useStore.getState().currentFilter;
  await loadAllTasks(f === 'trash' ? 'trash' : 'all');
}

export function useAutoShareSync(): void {
  useEffect(() => {
    let stopped = false;
    const seen = new Map<string, number>(); // shareId → last room version we synced
    const active = new Set<string>();        // shares with a running long-poll loop

    // One share's long-poll loop: wait for a change, sync, repeat.
    const pollShare = async (id: string) => {
      while (!stopped) {
        if (hidden()) { await sleep(HIDDEN_MS); continue; }
        const since = seen.get(id) ?? 0;
        const v = await shareRoomPoll(id, since); // held on the relay until it moves
        if (stopped) break;
        if (v !== since) {
          seen.set(id, v);
          await syncShare(id).catch(() => {});
          if (!stopped) await reloadView();
        } else {
          await sleep(IDLE_BACKOFF_MS); // timeout / offline → don't hot-loop
        }
      }
      active.delete(id);
    };

    // Start a poller for any share that doesn't have one yet.
    const ensurePollers = async () => {
      if (stopped) return;
      try {
        for (const s of await listShares()) {
          if (!active.has(s.id)) { active.add(s.id); void pollShare(s.id); }
        }
      } catch { /* offline — retry next tick */ }
    };

    // Safety net: heartbeat presence and force a full sync periodically.
    const slowTick = async () => {
      if (stopped) return;
      try {
        const shares = await listShares();
        if (shares.length === 0) return;
        await Promise.allSettled(shares.map(async (s) => {
          const full = await getShare(s.id);
          if (full) await heartbeat(full);
        }));
        const results = await syncAllShares();
        const changed = Object.values(results).some((r) => 'upserts' in r && (r.upserts > 0 || r.deletes > 0));
        if (changed && !stopped) await reloadView();
      } catch { /* swallow */ }
    };

    void ensurePollers();
    const discover = setInterval(ensurePollers, 30_000); // pick up newly-added shares
    const firstSlow = setTimeout(slowTick, 10_000);
    const slow = setInterval(slowTick, SLOW_MS);
    return () => { stopped = true; clearInterval(discover); clearTimeout(firstSlow); clearInterval(slow); };
  }, []);
}
