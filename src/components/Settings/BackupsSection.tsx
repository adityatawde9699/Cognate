/* Data-safety settings (backups + integrity). Self-contained: owns its own
   state and loads on mount. Desktop-only — renders nothing in the browser. */

import { useEffect, useState } from 'react';
import { IS_TAURI } from '../../db';
import {
  createBackup, listBackups, restoreBackup, deleteBackup, runIntegrityCheck, type BackupInfo,
} from '../../services/backupService';
import { toast } from '../../utils/toast';

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1_048_576).toFixed(1)} MB`;

export function BackupsSection() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [integrity, setIntegrity] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) return;
    listBackups().then(setBackups).catch(() => setBackups([]));
    runIntegrityCheck().then(setIntegrity);
  }, []);

  const refresh = async () => setBackups(await listBackups());

  const backupNow = async () => {
    setBusy(true);
    try {
      await createBackup('manual');
      await refresh();
      toast('💾 Backup created');
    } catch (e: any) {
      toast(`Backup failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (b: BackupInfo) => {
    if (!window.confirm(
      `Restore from ${b.name}?\n\nYour current data is snapshotted first (a "pre-restore" backup), then replaced. The app will reload.`
    )) return;
    setBusy(true);
    try {
      await restoreBackup(b.name);
      toast('Restored — reloading…');
      setTimeout(() => window.location.reload(), 600);
    } catch (e: any) {
      toast(`Restore failed: ${e?.message || e}`);
      setBusy(false);
    }
  };

  const remove = async (b: BackupInfo) => {
    if (!window.confirm(`Delete backup ${b.name}? This cannot be undone.`)) return;
    await deleteBackup(b.name);
    await refresh();
  };

  if (!IS_TAURI) return null;

  return (
    <div className="settings-section">
      <h3>Data safety</h3>

      <div className="form-group row">
        <label>Database health</label>
        <span className={`db-health ${integrity && integrity !== 'ok' ? 'is-bad' : 'is-ok'}`}>
          <i className={`fa-solid ${integrity && integrity !== 'ok' ? 'fa-triangle-exclamation' : 'fa-shield-heart'}`}></i>
          {integrity === 'ok' ? 'Healthy' : integrity ? integrity : 'Checking…'}
        </span>
      </div>

      <button className="btn-soft" onClick={backupNow} disabled={busy}>
        <i className="fa-solid fa-floppy-disk"></i> Back up now
      </button>

      {backups.length === 0 ? (
        <small className="form-hint">No backups yet. One is taken automatically each day.</small>
      ) : (
        <ul className="backup-list">
          {backups.map((b) => (
            <li key={b.name} className="backup-row">
              <div className="backup-row-main">
                <span className="backup-when">{new Date(b.created_ms).toLocaleString()}</span>
                <span className="backup-meta">
                  <span className={`backup-tag tag-${b.reason}`}>{b.reason}</span>
                  {fmtSize(b.size)}
                </span>
              </div>
              <div className="backup-row-actions">
                <button className="btn-ghost" onClick={() => restore(b)} disabled={busy} title="Restore this backup">
                  <i className="fa-solid fa-rotate-left"></i>
                </button>
                <button className="btn-ghost is-danger" onClick={() => remove(b)} disabled={busy} title="Delete backup">
                  <i className="fa-solid fa-xmark"></i>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <small className="form-hint">
        Backups are full snapshots kept on this device (latest {10} retained). Restore replaces your current data after snapshotting it first.
      </small>
    </div>
  );
}
