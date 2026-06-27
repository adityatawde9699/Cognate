import { useEffect } from 'react';
import { maybeAutoBackup, runIntegrityCheck } from '../services/backupService';
import { toast } from '../utils/toast';

/**
 * Boot-time data safety (Act 0): verify the database is intact, then take an
 * automatic daily backup. Runs once at app start. Both steps no-op cleanly in
 * the browser fallback where there is no SQLite file.
 */
export function useDataSafety() {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await runIntegrityCheck();
      if (!cancelled && status !== 'ok') {
        toast(`⚠ Database integrity issue (${status}). Restore a backup in Settings → Data safety.`);
      }
      if (!cancelled) await maybeAutoBackup();
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
