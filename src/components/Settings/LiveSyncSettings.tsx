/* End-to-end-encrypted live sync settings. Self-contained: owns relay config
   state and loads it on mount. The relay token (optional) gates a hosted relay
   against strangers — it is NOT a decryption key; the relay still only ever
   sees ciphertext. */

import { useEffect, useState } from 'react';
import {getSecret,setSecret} from '../../utils/secrets';
import {deriveRoomId} from '../../services/crypto';
import {syncDiagnostics} from '../../services/batchSync';
import { enableSync, disableSync, getConfig, syncNow } from '../../services/relayService';
import { toast } from '../../utils/toast';

const TOKEN_KEY = 'sync_relay_token';

export function LiveSyncSettings() {
  const [url, setUrl] = useState('');
  const [pass, setPass] = useState('');
  const [token, setToken] = useState('');
  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState('');
  const [health,setHealth]=useState('');
  const updateHealth=async()=>{const cfg=await getConfig();if(cfg){const d=await syncDiagnostics(await deriveRoomId(cfg.passphrase),cfg.url);setHealth(`Saved cursor ${d.cursor} · ${d.pending} queued operations${d.lastError ? ` · Last error: ${d.lastError}`:''}`);}};
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getConfig().then((cfg) => {
      setOn(!!cfg);
      setUrl(cfg?.url || '');
      setPass(cfg?.passphrase || '');
    });
    getSecret(TOKEN_KEY).then(setToken).catch(error=>setMsg(error.message));
    void updateHealth();
  }, []);

  const save = async () => {
    if (!url.trim() || !pass.trim()) { setMsg('Enter both a relay URL and a passphrase.'); return; }
    setBusy(true);
    setMsg('');
    try {
      await enableSync(url, pass);
      await setSecret(TOKEN_KEY, token.trim());
      const r = await syncNow();
      setOn(true);
      setMsg(`Connected. Pushed ${r.pushed} ops · merged ${r.mergedOps} · ${r.upserts} updated, ${r.deletes} removed.`);
      toast('🔐 Live sync connected');
    } catch (err: any) {
      setMsg(err?.message || 'Could not connect to the relay.');
    } finally {
      setBusy(false);void updateHealth();
    }
  };

  const sync = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await syncNow();
      setMsg(`Synced. Merged ${r.mergedOps} ops · ${r.upserts} updated, ${r.deletes} removed.`);
      toast('🔐 Synced');
    } catch (err: any) {
      setMsg(err?.message || 'Sync failed.');
    } finally {
      setBusy(false);void updateHealth();
    }
  };

  const turnOff = async () => {
    await disableSync();
    setOn(false);
    setPass('');
    setMsg('Live sync turned off. Your data stays on this device.');
  };

  return (
    <div className="settings-section">
      <h3>Live sync <span className="opt-tag">end-to-end encrypted</span></h3>

      {on && (
        <div className="sync-active-banner">
          <div className="sync-active-inner">
            <i className="fa-solid fa-circle-dot sync-active-dot"></i>
            <div>
              <strong>Sync is active</strong>
              <p>Your tasks are being pushed to <code>{url}</code> every 3 minutes.</p>
            </div>
          </div>
          <button className="btn-ghost is-danger" onClick={turnOff} disabled={busy}>
            <i className="fa-solid fa-link-slash"></i> Disable sync
          </button>
        </div>
      )}

      <div className="form-group">
        <label>Relay URL</label>
        <input
          type="url" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-relay.example  (or self-hosted)" autoComplete="off"
        />
      </div>
      <div className="form-group">
        <label>Sync passphrase</label>
        <input
          type="password" value={pass} onChange={(e) => setPass(e.target.value)}
          placeholder="a strong shared secret" autoComplete="off"
        />
        <small className="form-hint">
          Anyone with this passphrase can read this workspace and enroll a signed device.
          Use a strong secret and share it only with your own trusted devices.
          A v2 relay is required; legacy relay blobs remain available for explicit migration.
        </small>
      </div>
      <div className="form-group">
        <label>Relay access token <span className="opt-tag">optional</span></label>
        <input
          type="password" value={token} onChange={(e) => setToken(e.target.value)}
          placeholder="only if your relay requires one" autoComplete="off"
        />
        <small className="form-hint">
          A shared bearer token for a hosted/gated relay. Not a decryption key — the relay still can't read your tasks.
        </small>
      </div>

      <div className="sync-grid">
        <button className="btn-soft" onClick={save} disabled={busy}>
          <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-link'}`}></i> {on ? 'Reconnect' : 'Connect & sync'}
        </button>
        {on && (
          <button className="btn-soft" onClick={sync} disabled={busy}>
            <i className="fa-solid fa-rotate"></i> Sync now
          </button>
        )}
        {on && (
          <button className="btn-ghost is-danger" onClick={turnOff} disabled={busy}>
            <i className="fa-solid fa-link-slash"></i> Turn off
          </button>
        )}
      </div>
      {health && <small className="form-hint" role="status">{health}</small>}
      {msg && <small className="form-hint">{msg}</small>}
      <small className="form-hint">
        The relay stores only ciphertext — it can't read your tasks. Edits merge conflict-free (CRDT),
        so devices converge even after working offline.
      </small>
    </div>
  );
}
