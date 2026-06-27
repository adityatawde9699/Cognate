import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pretend we're under Tauri so the service hits the (mocked) IPC layer.
const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn().mockResolvedValue(undefined),
  checkpoint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: h.invoke }));
vi.mock('../db', () => ({
  IS_TAURI: true,
  checkpoint: h.checkpoint,
  integrityCheck: vi.fn().mockResolvedValue('ok'),
  getSetting: h.getSetting,
  setSetting: h.setSetting,
}));

import {
  createBackup,
  maybeAutoBackup,
  restoreBackup,
  deleteBackup,
} from './backupService';

const sample = { name: 'cognote-x.db', path: '', size: 1, created_ms: 1, reason: 'manual' };

describe('backupService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('createBackup checkpoints the WAL before snapshotting', async () => {
    h.invoke.mockResolvedValue(sample);
    const r = await createBackup('manual');
    expect(h.checkpoint).toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledWith('backup_database', { reason: 'manual' });
    expect(r?.name).toBe('cognote-x.db');
  });

  it('maybeAutoBackup skips when a backup was taken within the last day', async () => {
    h.getSetting.mockResolvedValue(String(Date.now()));
    await maybeAutoBackup();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('maybeAutoBackup backs up when stale and records the timestamp', async () => {
    h.getSetting.mockResolvedValue('0');
    h.invoke.mockResolvedValue({ ...sample, reason: 'auto' });
    await maybeAutoBackup();
    expect(h.invoke).toHaveBeenCalledWith('backup_database', { reason: 'auto' });
    expect(h.setSetting).toHaveBeenCalledWith('last_backup_at', expect.any(String));
  });

  it('restore and delete forward the backup name to the backend', async () => {
    h.invoke.mockResolvedValue(undefined);
    await restoreBackup('cognote-x.db');
    expect(h.invoke).toHaveBeenCalledWith('restore_backup', { name: 'cognote-x.db' });
    await deleteBackup('cognote-x.db');
    expect(h.invoke).toHaveBeenCalledWith('delete_backup', { name: 'cognote-x.db' });
  });
});
