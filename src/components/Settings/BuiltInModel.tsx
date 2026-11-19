import { useCallback, useEffect, useState } from 'react';
import {
  cancelBuiltInDownload, deleteBuiltInModel, describeHardware, downloadBuiltInModel,
  formatBytes, getLocalLlmStatus, onDownloadProgress,
  type DownloadProgress, type LocalLlmStatus,
} from '../../services/localLlm';

interface Props { model: string; onSelect: (id: string) => void }

/** Pick, download and remove the model that runs inside the app. */
export function BuiltInModel({ model, onSelect }: Props) {
  const [status, setStatus] = useState<LocalLlmStatus | null | undefined>(undefined);
  const [progress, setProgress] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState('');

  const refresh = useCallback(() => {
    getLocalLlmStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    let off: (() => void) | undefined;
    let alive = true;
    onDownloadProgress((p) => {
      setProgress((cur) => ({ ...cur, [p.id]: p }));
      if (p.phase === 'error') setError(p.error || 'Download failed.');
      if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') refresh();
    }).then((fn) => { if (alive) off = fn; else fn(); });
    return () => { alive = false; off?.(); };
  }, [refresh]);

  if (status === undefined) return <small className="form-hint">Checking this device…</small>;
  if (status === null) {
    return <small className="form-hint" role="status">{describeHardware(null)}</small>;
  }

  const start = async (id: string) => {
    setError('');
    onSelect(id);
    try { await downloadBuiltInModel(id); } catch (e: any) {
      const m = typeof e === 'string' ? e : e?.message || '';
      if (m && m !== 'cancelled') setError(m);
    }
    refresh();
  };

  return (
    <div className="form-group builtin">
      <label>Model</label>
      <small className="form-hint" role="status">{describeHardware(status.hardware)} Runs fully on this device, with no separate server.</small>
      <div className="builtin-list" role="radiogroup" aria-label="Built-in model">
        {status.models.map((m) => {
          const p = progress[m.id];
          const busy = m.downloading || p?.phase === 'downloading' || p?.phase === 'verifying';
          const pct = p && p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
          return (
            <div key={m.id} className={`builtin-row${model === m.id ? ' on' : ''}`}>
              <label className="builtin-pick">
                <input type="radio" name="builtin-model" checked={model === m.id}
                  onChange={() => onSelect(m.id)} aria-label={m.label} />
                <span>
                  <strong>{m.label}</strong>
                  <small className="form-hint">{m.blurb} {formatBytes(m.sizeBytes)}.</small>
                </span>
              </label>
              {busy ? (
                <div className="builtin-actions">
                  <progress max={100} value={p?.phase === 'verifying' ? 100 : pct} aria-label={`Downloading ${m.label}`} />
                  <span className="builtin-pct">{p?.phase === 'verifying' ? 'Verifying' : `${pct}%`}</span>
                  <button className="btn-ghost" onClick={() => cancelBuiltInDownload(m.id)}>Cancel</button>
                </div>
              ) : m.installed ? (
                <div className="builtin-actions">
                  <span className="builtin-ready">Downloaded</span>
                  <button className="btn-ghost" onClick={async () => { await deleteBuiltInModel(m.id); refresh(); }}>Remove</button>
                </div>
              ) : (
                <div className="builtin-actions">
                  <button className="btn-ghost" onClick={() => start(m.id)}>Download</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <small className="form-hint" role="alert" style={{ color: 'var(--danger)' }}>{error}</small>}
    </div>
  );
}
