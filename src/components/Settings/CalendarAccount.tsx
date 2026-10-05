/* Live calendar (Google / Outlook) free-busy over OAuth + PKCE (Act 1).
   Desktop-only — the token + API calls run in Rust. Read-only: meetings become
   busy blocks the planner schedules around; Cognate never writes to your
   calendar. Needs your own OAuth client id (provider app approval is external). */

import { useEffect, useState } from 'react';
import { IS_TAURI, getSetting, setSetting } from '../../db';
import {
  CAL_PROVIDERS, beginConnect, cancelConnect, completeConnect, syncFreeBusy,
  isCalendarConnected, disconnectCalendar, type CalProvider,
} from '../../services/oauthCalendarService';
import { toast } from '../../utils/toast';

const CLIENT_ID_KEY = 'cal_oauth_client_id';

export function CalendarAccount() {
  const [provider, setProvider] = useState<CalProvider>('google');
  const [clientId, setClientId] = useState('');
  const [authUrl, setAuthUrl] = useState('');
  const [code, setCode] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    isCalendarConnected().then(setConnected).catch(e=>setMsg(e.message));
    getSetting(CLIENT_ID_KEY, '').then(setClientId);
  }, []);

  useEffect(()=>{
    if(!IS_TAURI) return;
    let disposed=false; let unlisten:(()=>void)|undefined;
    import('@tauri-apps/api/event').then(({listen})=>listen<string>('calendar-oauth-callback',async event=>{
      setBusy(true);
      try {await completeConnect(event.payload);setConnected(true);setAuthUrl('');setCode('');await syncFreeBusy(7);setMsg('Connected. Calendar availability refreshed.');}
      catch(error:any){setMsg(error.message);}
      finally {setBusy(false);}
    })).then(stop=>{if(disposed)stop();else unlisten=stop;}).catch(error=>setMsg(error.message));
    return ()=>{disposed=true;unlisten?.();};
  },[]);
  const cancel=async()=>{await cancelConnect();setAuthUrl('');setCode('');setMsg('Sign-in cancelled.');};
  const connect = async () => {
    setBusy(true); setMsg('');
    try {
      await setSetting(CLIENT_ID_KEY, clientId.trim());
      const url = await beginConnect(provider, clientId);
      setAuthUrl(url);
      const {open}=await import('@tauri-apps/plugin-shell');
      await open(url);
      setMsg('Open the link, approve read-only access, then return here. Sign-in completes automatically. You can also paste the full callback URL.');
    } catch (e: any) {
      setMsg(e?.message || 'Could not start sign-in.');
    } finally { setBusy(false); }
  };

  const finish = async () => {
    if (!code.trim()) { setMsg('Paste the complete redirected URL first.'); return; }
    setBusy(true); setMsg('');
    try {
      await completeConnect(code);
      setConnected(true);
      setAuthUrl(''); setCode('');
      const n = await syncFreeBusy(7);
      setMsg(`Connected — imported ${n} busy block${n === 1 ? '' : 's'} for the next 7 days.`);
      toast('📅 Calendar connected');
    } catch (e: any) {
      setMsg(e?.message || 'Could not complete sign-in.');
    } finally { setBusy(false); }
  };

  const sync = async () => {
    setBusy(true); setMsg('');
    try {
      const n = await syncFreeBusy(7);
      setMsg(`Refreshed — ${n} busy block${n === 1 ? '' : 's'} for the next 7 days.`);
      toast('📅 Free/busy synced');
    } catch (e: any) {
      setMsg(e?.message || 'Sync failed.');
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    await disconnectCalendar();
    setConnected(false);
    setMsg('Disconnected. Your tokens were removed from the keychain.');
  };

  if (!IS_TAURI) return null; // OAuth runs through the desktop Rust layer

  return (
    <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginTop: '4px' }}>
      <label>Calendar account <span className="opt-tag">free/busy · read-only</span></label>

      {connected ? (
        <div className="sync-grid">
          <button className="btn-soft" onClick={sync} disabled={busy}>
            <i className={`fa-solid ${busy ? 'fa-spinner fa-spin' : 'fa-rotate'}`}></i> Sync free/busy
          </button>
          <button className="btn-ghost is-danger" onClick={disconnect} disabled={busy}>
            <i className="fa-solid fa-link-slash"></i> Disconnect
          </button>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <select value={provider} onChange={(e) => setProvider(e.target.value as CalProvider)} style={{ flex: '0 0 auto' }}>
              {Object.entries(CAL_PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <input
              type="text" value={clientId} placeholder="OAuth client id"
              onChange={(e) => setClientId(e.target.value)} style={{ flex: '1 1 160px' }} autoComplete="off"
            />
            <button className="btn-soft" onClick={connect} disabled={busy || !clientId.trim()}>
              <i className="fa-solid fa-right-to-bracket"></i> Connect
            </button>
          </div>

          {authUrl && (
            <div style={{ marginTop: '8px' }}>
              <button className="btn-ghost" onClick={cancel}>Cancel sign-in</button>
              <a href={authUrl} target="_blank" rel="noreferrer" className="form-hint" style={{ color: 'var(--accent)', wordBreak: 'break-all' }}>
                Open the consent page ↗
              </a>
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <input
                  type="text" value={code} placeholder="Paste the complete callback URL…"
                  onChange={(e) => setCode(e.target.value)} style={{ flex: 1 }} autoComplete="off"
                />
                <button className="btn-soft" onClick={finish} disabled={busy}>
                  <i className="fa-solid fa-check"></i> Finish
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {msg && <small className="form-hint">{msg}</small>}
      <small className="form-hint">
        Uses OAuth 2.0 + PKCE; tokens are kept in your OS keychain and refreshed automatically. Read-only —
        Cognate never writes to your calendar. Requires your own OAuth client id.
      </small>
    </div>
  );
}
