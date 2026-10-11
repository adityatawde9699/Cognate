import { useEffect, useState } from 'react';
import { clearDiagnostics, diagnosticReport } from '../../services/diagnostics';
import { downloadStr } from '../../utils/export';
import { IS_TAURI } from '../../db';
import { notify } from '../../utils/notify';

export function DiagnosticsSection() {
  const [report, setReport] = useState(diagnosticReport);
  const [native, setNative] = useState('');
  const [checking, setChecking] = useState(false);
  const checkNative = async () => {
    setChecking(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const checks = await invoke<{check:string;passed:boolean}[]>('desktop_health');
      setNative(checks.map(c => `${c.check}: ${c.passed ? 'passed' : 'failed'}`).join(' · '));
    } catch { setNative('Desktop checks could not complete. Existing data is unchanged.'); }
    finally { setChecking(false); }
  };
  useEffect(() => {
    const refresh = () => setReport(diagnosticReport());
    window.addEventListener('diagnostics-changed', refresh);
    return () => window.removeEventListener('diagnostics-changed', refresh);
  }, []);
  return <section className="settings-section" aria-label="Diagnostics">
    <h3>Diagnostics</h3>
    <p className="form-hint">Local session results only: operation type, outcome, time and duration. No task text, identifiers, URLs, prompts or credentials. Nothing is uploaded.</p>
    <p role="status">{report.events.length} recent operations · {report.events.filter(e => e.outcome !== 'ok').length} failures or cancellations</p>
    <div className="sync-grid">
      <button className="btn-soft" onClick={() => downloadStr(JSON.stringify(report, null, 2), 'cognate-diagnostics.json', 'application/json')}>Export diagnostics</button>
      <button className="btn-ghost" onClick={clearDiagnostics}>Clear diagnostics</button>
      {IS_TAURI && <button className="btn-soft" disabled={checking} onClick={checkNative}>Check desktop integration</button>}
      <button className="btn-soft" onClick={()=>void notify('Cognate notification test', 'Notifications are working. Open Cognate from the tray to continue.').then(result=>setNative(`Notification: ${result}`))}>Test notification</button>
    </div>
    {native && <p role="status">{native}</p>}
    <ul>{report.events.slice(-8).reverse().map((event, index) => <li key={index}>{event.area} · {event.outcome} · {event.duration_ms} ms</li>)}</ul>
  </section>;
}
