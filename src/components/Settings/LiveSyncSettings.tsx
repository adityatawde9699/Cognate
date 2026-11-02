/* End-to-end-encrypted live sync settings. Self-contained: owns relay config
   state and loads it on mount. Supports Sync Protocol v3 with Setup Codes,
   join verification, migration from v2, and relay soft-delete. */

import { useEffect, useState } from 'react';
import { getSecret, setSecret } from '../../utils/secrets';
import {
  validatePassphrase,
  deriveRoomId,
  deriveSyncV3,
  decodeSetupCode,
} from '../../services/crypto';
import { syncDiagnostics } from '../../services/batchSync';
import {
  enableSync,
  disableSync,
  getConfig,
  getWorkspaceBinding,
  syncNow,
  type RelayConfig,
  type WorkspaceBinding,
} from '../../services/relayService';
import {
  createWorkspaceGenesis,
  joinWorkspaceV3,
  migrateV2ToV3,
  retireLegacyV2Room,
  cancelLegacyV2SoftDelete,
} from '../../services/migrationService';
import { toast } from '../../utils/toast';

const TOKEN_KEY = 'sync_relay_token';

export function LiveSyncSettings() {
  const [url, setUrl] = useState('');
  const [pass, setPass] = useState('');
  const [token, setToken] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [mode, setMode] = useState<'create' | 'join' | 'legacy'>('create');

  const [cfg, setCfg] = useState<RelayConfig | null>(null);
  const [binding, setBinding] = useState<WorkspaceBinding | null>(null);

  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState('');
  const [health, setHealth] = useState('');
  const [busy, setBusy] = useState(false);

  // Migration & legacy deletion UI state
  const [v3MigratePass, setV3MigratePass] = useState('');
  const [confirmOverride, setConfirmOverride] = useState(false);
  const [softDeletePending, setSoftDeletePending] = useState(false);

  const updateHealth = async () => {
    const currentCfg = await getConfig();
    if (currentCfg) {
      let room: string;
      if (currentCfg.version === 3 && currentCfg.setupCode) {
        try {
          const creds = await deriveSyncV3(currentCfg.passphrase, decodeSetupCode(currentCfg.setupCode));
          room = creds.room;
        } catch {
          room = await deriveRoomId(currentCfg.passphrase);
        }
      } else {
        room = await deriveRoomId(currentCfg.passphrase);
      }
      const d = await syncDiagnostics(room, currentCfg.url);
      setHealth(
        `Saved cursor ${d.cursor} · ${d.pending} queued operations · Last successful sync: ${d.lastSuccess || 'never'}${
          d.retryAt && d.retryAt > Date.now() ? ` · Retry after ${new Date(d.retryAt).toLocaleTimeString()}` : ''
        }${d.lastError ? ' · Previous sync failed; queued edits are retained.' : ''}`
      );
    }
  };

  const reload = async () => {
    const currentCfg = await getConfig();
    const currentBinding = await getWorkspaceBinding();
    setCfg(currentCfg);
    setBinding(currentBinding);
    setOn(!!currentCfg);
    setUrl(currentCfg?.url || '');
    setPass(currentCfg?.passphrase || '');
    setSetupCode(currentCfg?.setupCode || '');
  };

  useEffect(() => {
    reload();
    getSecret(TOKEN_KEY)
      .then(setToken)
      .catch((error) => setMsg(error.message));
    const refresh = () =>
      void updateHealth().catch(() =>
        setHealth('Sync health unavailable. Local edits remain on this device.')
      );
    refresh();
    window.addEventListener('diagnostics-changed', refresh);
    return () => window.removeEventListener('diagnostics-changed', refresh);
  }, []);

  const handleCreate = async () => {
    if (!url.trim() || !pass.trim()) {
      setMsg('Enter both a relay URL and a passphrase.');
      return;
    }
    const check = validatePassphrase(pass);
    if (!check.valid) {
      setMsg(check.error || 'Passphrase does not meet security requirements.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      await createWorkspaceGenesis(url.trim(), pass.trim());
      await setSecret(TOKEN_KEY, token.trim());
      const r = await syncNow();
      await reload();
      setMsg(
        `Connected. Pushed ${r.pushed} ops · merged ${r.mergedOps} · ${r.upserts} updated, ${r.deletes} removed.`
      );
      toast('🔐 Live sync v3 workspace created');
    } catch (err: any) {
      setMsg(err?.message || 'Could not create workspace on relay.');
    } finally {
      setBusy(false);
      void updateHealth().catch(() => setHealth('Sync health unavailable.'));
    }
  };

  const handleJoin = async () => {
    if (!url.trim() || !pass.trim() || !setupCode.trim()) {
      setMsg('Enter Relay URL, Setup Code, and Passphrase.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      await joinWorkspaceV3(url.trim(), pass.trim(), setupCode.trim());
      await setSecret(TOKEN_KEY, token.trim());
      const r = await syncNow();
      await reload();
      setMsg(
        `Joined workspace. Merged ${r.mergedOps} ops · ${r.upserts} updated, ${r.deletes} removed.`
      );
      toast('🔐 Joined workspace successfully');
    } catch (err: any) {
      setMsg(err?.message || 'Could not join workspace.');
    } finally {
      setBusy(false);
      void updateHealth().catch(() => setHealth('Sync health unavailable.'));
    }
  };

  const handleLegacyConnect = async () => {
    if (!url.trim() || !pass.trim()) {
      setMsg('Enter both a relay URL and a passphrase.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      await enableSync(url.trim(), pass.trim());
      await setSecret(TOKEN_KEY, token.trim());
      const r = await syncNow();
      await reload();
      setMsg(
        `Connected to v2 relay. Pushed ${r.pushed} ops · merged ${r.mergedOps} · ${r.upserts} updated, ${r.deletes} removed.`
      );
      toast('🔐 Connected to legacy relay');
    } catch (err: any) {
      setMsg(err?.message || 'Could not connect to relay.');
    } finally {
      setBusy(false);
      void updateHealth().catch(() => setHealth('Sync health unavailable.'));
    }
  };

  const handleUpgradeToV3 = async () => {
    const targetPass = v3MigratePass.trim() || pass.trim();
    const check = validatePassphrase(targetPass);
    if (!check.valid) {
      setMsg(check.error || 'V3 passphrase must be at least 12 characters.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const res = await migrateV2ToV3(targetPass);
      await reload();
      setMsg(`Upgraded to Sync v3! Setup Code: ${res.setupCode}`);
      toast('🚀 Upgraded to Sync Protocol v3');
    } catch (err: any) {
      setMsg(err?.message || 'Migration to v3 failed.');
    } finally {
      setBusy(false);
      void updateHealth().catch(() => setHealth('Sync health unavailable.'));
    }
  };

  const handleDeleteLegacyV2 = async () => {
    if (!cfg || !binding?.v2_fallback?.room || !cfg.deleteToken) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await retireLegacyV2Room(cfg.url, binding.v2_fallback.room, cfg.deleteToken);
      if (res.soft_deleted) {
        setSoftDeletePending(true);
        setMsg(
          `Legacy v2 room is soft-deleted. Permanent purge in 7 days (${res.purge_after_seconds} seconds).`
        );
        toast('🗑️ Legacy v2 room soft-deleted');
      }
    } catch (err: any) {
      setMsg(err?.message || 'Failed to soft-delete legacy relay data.');
    } finally {
      setBusy(false);
    }
  };

  const handleCancelSoftDelete = async () => {
    if (!cfg || !binding?.v2_fallback?.room || !cfg.deleteToken) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await cancelLegacyV2SoftDelete(cfg.url, binding.v2_fallback.room, cfg.deleteToken);
      if (!res.soft_deleted) {
        setSoftDeletePending(false);
        setMsg('Soft-delete cancelled. Legacy v2 room has been restored.');
        toast('↩️ Legacy room deletion cancelled');
      }
    } catch (err: any) {
      setMsg(err?.message || 'Failed to cancel soft-delete.');
    } finally {
      setBusy(false);
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
      setBusy(false);
      void updateHealth().catch(() => setHealth('Sync health unavailable.'));
    }
  };

  const turnOff = async () => {
    await disableSync();
    await reload();
    setHealth('Sync is disabled.');
    setPass('');
    setSetupCode('');
    setMsg('Live sync turned off. Your data stays on this device.');
  };

  const copySetupCode = () => {
    if (cfg?.setupCode) {
      navigator.clipboard.writeText(cfg.setupCode);
      toast('📋 Setup Code copied to clipboard');
    }
  };

  return (
    <div className="settings-section">
      <h3>
        Live sync <span className="opt-tag">end-to-end encrypted</span>
      </h3>

      {on && (
        <div className="sync-active-banner">
          <div className="sync-active-inner">
            <i className="fa-solid fa-circle-dot sync-active-dot"></i>
            <div>
              <strong>Sync is active (Protocol {cfg?.version === 3 ? 'v3' : 'v2'})</strong>
              <p>
                Your tasks are being synchronized with <code>{url}</code>.
              </p>
            </div>
          </div>
          <button className="btn-ghost is-danger" onClick={turnOff} disabled={busy}>
            <i className="fa-solid fa-link-slash"></i> Disable sync
          </button>
        </div>
      )}

      {on && cfg?.version === 3 && (
        <div className="form-group" style={{ background: 'rgba(0,0,0,0.03)', padding: '12px', borderRadius: '8px' }}>
          <label>Setup Code (for pairing new devices)</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
            <input
              type="text"
              readOnly
              value={cfg.setupCode || ''}
              style={{ fontFamily: 'monospace', fontWeight: 600, letterSpacing: '0.05em' }}
            />
            <button className="btn-soft" onClick={copySetupCode} title="Copy Setup Code">
              <i className="fa-solid fa-copy"></i> Copy
            </button>
          </div>
          <small className="form-hint">
            To connect another device, select &ldquo;Join Existing Workspace&rdquo; on that device and enter this Setup Code alongside your sync passphrase.
          </small>
        </div>
      )}

      {on && cfg?.version === 2 && (
        <div className="form-group" style={{ border: '1px solid #f59e0b', padding: '14px', borderRadius: '8px', background: '#fffbeb' }}>
          <strong style={{ color: '#b45309' }}>
            <i className="fa-solid fa-triangle-exclamation"></i> Sync Protocol v2 Active
          </strong>
          <p style={{ margin: '6px 0', fontSize: '13px', color: '#78350f' }}>
            Upgrade to Sync Protocol v3 for hardened per-room salt derivation, Crockford Base32 Setup Codes, and two-factor confidentiality.
          </p>
          <div style={{ marginTop: '10px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600 }}>V3 Passphrase (min 12 chars)</label>
            <input
              type="password"
              placeholder="Enter or confirm passphrase (>= 12 characters)"
              value={v3MigratePass || pass}
              onChange={(e) => setV3MigratePass(e.target.value)}
              style={{ margin: '4px 0 8px 0' }}
            />
            <button className="btn-soft" onClick={handleUpgradeToV3} disabled={busy}>
              <i className="fa-solid fa-arrow-up-right-from-square"></i> Upgrade to Sync v3
            </button>
          </div>
        </div>
      )}

      {on && binding?.v2_fallback?.room && (
        <div className="form-group" style={{ border: '1px dashed #94a3b8', padding: '12px', borderRadius: '8px', marginTop: '14px' }}>
          <strong>Legacy Relay Cleanup</strong>
          <p style={{ fontSize: '12px', margin: '4px 0 8px 0', color: '#64748b' }}>
            This workspace was migrated from v2. You can permanently erase historical v2 ciphertext from the relay.
          </p>
          {softDeletePending ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '13px', color: '#059669' }}>
                <i className="fa-solid fa-clock"></i> Soft-deleted. Permanent purge in 7 days.
              </span>
              <button className="btn-ghost" onClick={handleCancelSoftDelete} disabled={busy}>
                Cancel Deletion
              </button>
            </div>
          ) : (
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', margin: '6px 0' }}>
                <input
                  type="checkbox"
                  checked={confirmOverride}
                  onChange={(e) => setConfirmOverride(e.target.checked)}
                />
                I understand un-synced legacy devices may lose access
              </label>
              <button
                className="btn-ghost is-danger"
                onClick={handleDeleteLegacyV2}
                disabled={busy || !confirmOverride}
              >
                <i className="fa-solid fa-trash-can"></i> Finish migration and delete legacy relay data
              </button>
            </div>
          )}
        </div>
      )}

      {!on && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
          <button
            className={`btn-soft ${mode === 'create' ? 'is-active' : ''}`}
            onClick={() => setMode('create')}
            type="button"
          >
            Create Workspace (v3)
          </button>
          <button
            className={`btn-soft ${mode === 'join' ? 'is-active' : ''}`}
            onClick={() => setMode('join')}
            type="button"
          >
            Join Existing (v3)
          </button>
          <button
            className={`btn-ghost ${mode === 'legacy' ? 'is-active' : ''}`}
            onClick={() => setMode('legacy')}
            type="button"
          >
            Connect Legacy (v2)
          </button>
        </div>
      )}

      {!on && (
        <>
          <div className="form-group">
            <label>Relay URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-relay.example  (or self-hosted)"
              autoComplete="off"
            />
          </div>

          {mode === 'join' && (
            <div className="form-group">
              <label>Setup Code</label>
              <input
                type="text"
                value={setupCode}
                onChange={(e) => setSetupCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXX"
                autoComplete="off"
                style={{ fontFamily: 'monospace' }}
              />
              <small className="form-hint">
                Found in Settings &rarr; Live Sync on an already-connected device.
              </small>
            </div>
          )}

          <div className="form-group">
            <label>Sync passphrase</label>
            <input
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder={mode === 'legacy' ? 'shared secret' : 'mandatory strong secret (>= 12 characters)'}
              autoComplete="off"
            />
            <small className="form-hint">
              {mode === 'legacy'
                ? 'Legacy v2 passphrase. Consider using v3 for stronger security.'
                : 'Mandatory knowledge factor: must be at least 12 characters with at least 4 unique characters.'}
            </small>
          </div>

          <div className="form-group">
            <label>
              Relay access token <span className="opt-tag">optional</span>
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="only if your relay requires bearer authentication"
              autoComplete="off"
            />
          </div>

          <div className="sync-grid">
            {mode === 'create' && (
              <button className="btn-soft" onClick={handleCreate} disabled={busy}>
                <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-plus'}`}></i> Create &amp; Connect Workspace
              </button>
            )}
            {mode === 'join' && (
              <button className="btn-soft" onClick={handleJoin} disabled={busy}>
                <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-link'}`}></i> Join Workspace
              </button>
            )}
            {mode === 'legacy' && (
              <button className="btn-soft" onClick={handleLegacyConnect} disabled={busy}>
                <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-link'}`}></i> Connect Legacy v2
              </button>
            )}
          </div>
        </>
      )}

      {on && (
        <div className="sync-grid" style={{ marginTop: '12px' }}>
          <button className="btn-soft" onClick={sync} disabled={busy}>
            <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-rotate'}`}></i> Sync now
          </button>
        </div>
      )}

      {health && (
        <small className="form-hint" role="status" style={{ display: 'block', marginTop: '10px' }}>
          {health}
        </small>
      )}
      {msg && (
        <small className="form-hint" style={{ display: 'block', marginTop: '6px', color: '#2563eb' }}>
          {msg}
        </small>
      )}
      <small className="form-hint" style={{ display: 'block', marginTop: '8px' }}>
        The relay stores only ciphertext — it can&apos;t read your tasks. Edits merge conflict-free (CRDT), so devices converge even after working offline.
      </small>
    </div>
  );
}
