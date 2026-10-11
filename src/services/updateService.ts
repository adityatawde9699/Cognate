/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/updateService.ts — Auto-update (Act 0)
   Thin wrapper over @tauri-apps/plugin-updater. Updates are verified
   against the public key in tauri.conf.json before install, so a
   tampered package is rejected. No-op off Tauri.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { IS_TAURI } from '../db';
import { runDatabaseMaintenance } from '../db';
import { createBackup } from './backupService';
import { measured } from './diagnostics';

export interface AvailableUpdate {
  version: string;
  notes: string;
  /** The underlying plugin Update handle (used to download/install). */
  raw: {
    version: string;
    body?: string;
    downloadAndInstall: (onEvent?: (e: any) => void) => Promise<void>;
  };
}

/** Returns details of a newer signed release, or null if up to date / unavailable. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!IS_TAURI) return null;
  return measured('update', async () => {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;
    return { version: update.version, notes: update.body ?? '', raw: update as any };
  });
}

/**
 * Download + install an update (signature verified by the plugin), reporting
 * progress 0–100, then relaunch into the new version.
 */
export async function installUpdate(
  update: AvailableUpdate,
  onProgress?: (pct: number) => void
): Promise<void> {
  if (!IS_TAURI) throw new Error('Desktop updates require the installed app.');
  await measured('update', async () => {
  const backup = await createBackup('pre-update');
  if (!backup) throw new Error('A verified pre-update backup is required before installation.');
  let total = 0;
  let downloaded = 0;
  await runDatabaseMaintenance(async () => {
  await update.raw.downloadAndInstall((event: any) => {
    switch (event?.event) {
      case 'Started':
        total = Math.max(0, Number(event.data?.contentLength) || 0);
        onProgress?.(0);
        break;
      case 'Progress':
        downloaded += Math.max(0, Number(event.data?.chunkLength) || 0);
        if (total > 0) onProgress?.(Math.min(99, Math.round((downloaded / total) * 100)));
        break;
      case 'Finished':
        onProgress?.(100);
        break;
    }
  });
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
  }, true);
  });
}
