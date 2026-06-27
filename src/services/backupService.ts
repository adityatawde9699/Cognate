/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/backupService.ts — Data safety (Act 0)
   Thin frontend over the Rust backup commands. Every call is a
   no-op (or empty) off Tauri so the browser fallback stays happy.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { IS_TAURI, checkpoint, integrityCheck, getSetting, setSetting } from '../db';

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  created_ms: number;
  reason: string;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Take a consistent snapshot of the DB. Checkpoints the WAL first. */
export async function createBackup(reason = 'manual'): Promise<BackupInfo | null> {
  if (!IS_TAURI) return null;
  await checkpoint();
  return invoke<BackupInfo>('backup_database', { reason });
}

export async function listBackups(): Promise<BackupInfo[]> {
  if (!IS_TAURI) return [];
  return invoke<BackupInfo[]>('list_backups');
}

/** Restore a backup over the live DB. Caller should reload the app afterward. */
export async function restoreBackup(name: string): Promise<void> {
  if (!IS_TAURI) return;
  await invoke('restore_backup', { name });
}

export async function deleteBackup(name: string): Promise<void> {
  if (!IS_TAURI) return;
  await invoke('delete_backup', { name });
}

const DAY_MS = 86_400_000;
const LAST_BACKUP_KEY = 'last_backup_at';

/** Once per day, snapshot the DB automatically. Safe to call on every boot. */
export async function maybeAutoBackup(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    const last = Number(await getSetting(LAST_BACKUP_KEY, '0')) || 0;
    if (Date.now() - last < DAY_MS) return;
    await createBackup('auto');
    await setSetting(LAST_BACKUP_KEY, String(Date.now()));
  } catch (e) {
    console.warn('[backupService] auto-backup failed:', e);
  }
}

/** Run SQLite's integrity checks; returns 'ok' or a short problem description. */
export async function runIntegrityCheck(): Promise<string> {
  try {
    return await integrityCheck();
  } catch (e) {
    return `check failed: ${e}`;
  }
}
