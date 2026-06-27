import { useEffect } from 'react';
import { checkForUpdate } from '../services/updateService';
import { toast } from '../utils/toast';

/**
 * Boot-time auto-update check (Act 0). Quietly checks once at startup and, if a
 * newer signed release exists, nudges the user toward Settings → Updates. The
 * actual install is user-initiated there. No-op off Tauri / in dev.
 */
export function useAutoUpdate() {
  useEffect(() => {
    if (import.meta.env.DEV) return; // don't phone home from the dev server
    let cancelled = false;
    (async () => {
      const update = await checkForUpdate();
      if (!cancelled && update) {
        toast(`⬆️ Update ${update.version} available — install in Settings.`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
