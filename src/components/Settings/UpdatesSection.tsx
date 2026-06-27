/* Auto-update settings. Self-contained; desktop-only. */

import { useState } from 'react';
import { IS_TAURI } from '../../db';
import { checkForUpdate, installUpdate, type AvailableUpdate } from '../../services/updateService';

export function UpdatesSection() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [msg, setMsg] = useState('');
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const check = async () => {
    setChecking(true);
    setMsg('');
    try {
      const found = await checkForUpdate();
      setUpdate(found);
      setMsg(found ? '' : "You're on the latest version.");
    } catch (e: any) {
      setMsg(`Update check failed: ${e?.message || e}`);
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!update) return;
    setProgress(0);
    try {
      await installUpdate(update, setProgress);
      // installUpdate relaunches on success; if we get here, it's mid-flight.
    } catch (e: any) {
      setMsg(`Install failed: ${e?.message || e}`);
      setProgress(null);
    }
  };

  if (!IS_TAURI) return null;

  return (
    <div className="settings-section">
      <h3>Updates</h3>
      <button className="btn-soft" onClick={check} disabled={checking || progress !== null}>
        <i className={`fa-solid ${checking ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down'}`}></i> Check for updates
      </button>

      {update && progress === null && (
        <div className="update-card">
          <div className="update-head">
            <span className="backup-tag">v{update.version}</span>
            <span>A new version is available.</span>
          </div>
          {update.notes && <p className="form-hint update-notes">{update.notes}</p>}
          <button className="btn-primary" onClick={install}>
            <i className="fa-solid fa-download"></i> Install &amp; restart
          </button>
        </div>
      )}

      {progress !== null && (
        <div className="update-progress">
          <div className="deck-track"><div className="deck-fill" style={{ width: `${progress}%` }}></div></div>
          <span>{progress < 100 ? `Downloading… ${progress}%` : 'Installing — the app will restart.'}</span>
        </div>
      )}

      {msg && <small className="form-hint">{msg}</small>}
      <small className="form-hint">Updates are cryptographically verified before install.</small>
    </div>
  );
}
