/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/hooks/useAutoSync.ts
   When live sync is configured, periodically push local changes and pull
   remote ones so devices stay converged without manual action. Best-effort:
   a failed round (offline, relay down) is swallowed and retried next tick —
   the local-first app keeps working regardless.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useEffect } from 'react';
import { isSyncEnabled, syncNow } from '../services/relayService';

const SYNC_MS = 3 * 60 * 1000; // every 3 minutes

export function useAutoSync(): void {
  useEffect(() => {
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        if (await isSyncEnabled()) await syncNow();
      } catch {
        // Offline or relay unreachable — try again next interval.
      }
    };

    // Sync shortly after boot (once tasks have hydrated), then on a cadence.
    const first = setTimeout(tick, 10_000);
    const interval = setInterval(tick, SYNC_MS);
    return () => { stopped = true; clearTimeout(first); clearInterval(interval); };
  }, []);
}
