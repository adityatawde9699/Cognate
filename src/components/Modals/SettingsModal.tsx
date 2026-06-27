import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { getSetting, setSetting, IS_TAURI } from '../../db';
import { getSecret, setSecret } from '../../utils/secrets';
import { saveCustomFieldDefs } from '../../services/customFields';
import { getAllTasks, dedupeTasks } from '../../db';
import { loadAllTasks } from '../../services/taskService';
import { exportIcs, importIcsText } from '../../services/icalService';
import { getCalendarUrl, setCalendarUrl, syncCalendarUrl, importBusyText } from '../../services/calendarSyncService';
import { parseImport, importTasks } from '../../services/importService';
import { exportBundle, importBundle } from '../../services/syncService';
import { SharedProjects } from '../SharedProjects';
import { BackupsSection } from '../Settings/BackupsSection';
import { UpdatesSection } from '../Settings/UpdatesSection';
import { LiveSyncSettings } from '../Settings/LiveSyncSettings';
import { CalendarAccount } from '../Settings/CalendarAccount';
import { LanguageSelect } from '../Settings/LanguageSelect';
import { enablePrivateAi } from '../../services/privateAi';
import { downloadStr } from '../../utils/export';
import { toast } from '../../utils/toast';
import type { CustomFieldType } from '../../store';

/** "09:00" ⇄ minutes-since-midnight, for the work-hours inputs. */
function timeToMin(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}
function minToTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function pickFile(accept: string, cb: (text: string, name: string) => void) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = accept;
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (f) cb(await f.text(), f.name);
  };
  inp.click();
}

interface ProviderMeta { label: string; model: string; base: string; needsKey: boolean; keyHint?: string }
const PROVIDERS: Record<string, ProviderMeta> = {
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-opus-4-8', base: '', needsKey: true, keyHint: 'console.anthropic.com' },
  openai:    { label: 'OpenAI', model: 'gpt-4o', base: 'https://api.openai.com/v1', needsKey: true, keyHint: 'platform.openai.com' },
  openrouter:{ label: 'OpenRouter', model: 'anthropic/claude-3.5-sonnet', base: 'https://openrouter.ai/api/v1', needsKey: true, keyHint: 'openrouter.ai/keys' },
  groq:      { label: 'Groq', model: 'llama-3.3-70b-versatile', base: 'https://api.groq.com/openai/v1', needsKey: true, keyHint: 'console.groq.com' },
  xai:       { label: 'xAI (Grok)', model: 'grok-2-latest', base: 'https://api.x.ai/v1', needsKey: true, keyHint: 'console.x.ai' },
  gemini:    { label: 'Google Gemini', model: 'gemini-2.0-flash', base: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, keyHint: 'aistudio.google.com' },
  ollama:    { label: 'Ollama (local)', model: 'llama3.1', base: 'http://localhost:11434/v1', needsKey: false },
  llamacpp:  { label: 'llama.cpp (local)', model: 'local-model', base: 'http://localhost:8080/v1', needsKey: false },
  custom:    { label: 'Custom / self-hosted', model: '', base: 'https://your-server/v1', needsKey: false },
};

export function SettingsModal() {
  const { isSettingsModalOpen, setSettingsModalOpen } = useStore();
  const customFieldDefs = useStore((s) => s.customFieldDefs);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isSettingsModalOpen);
  const [cfName, setCfName] = useState('');
  const [cfType, setCfType] = useState<CustomFieldType>('text');
  const [cfOptions, setCfOptions] = useState('');

  const addCustomField = async () => {
    const name = cfName.trim();
    if (!name) return;
    const def = {
      id: crypto.randomUUID(),
      name,
      type: cfType,
      options: cfType === 'select' ? cfOptions.split(',').map((o) => o.trim()).filter(Boolean) : undefined,
    };
    await saveCustomFieldDefs([...customFieldDefs, def]);
    setCfName(''); setCfOptions(''); setCfType('text');
  };
  const removeCustomField = async (id: string) => {
    await saveCustomFieldDefs(customFieldDefs.filter((d) => d.id !== id));
  };

  const [workMins, setWorkMins] = useState('25');
  const [shortBreakMins, setShortBreakMins] = useState('5');
  const [longBreakMins, setLongBreakMins] = useState('15');
  const [autoBreak, setAutoBreak] = useState(false);

  const [discordHook, setDiscordHook] = useState('');
  const [slackHook, setSlackHook] = useState('');
  const [aiProvider, setAiProvider] = useState('anthropic');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [quickAddAi, setQuickAddAi] = useState(false);

  const [workStart, setWorkStart] = useState('09:00');
  const [workEnd, setWorkEnd] = useState('17:00');
  const [calUrl, setCalUrl] = useState('');
  const [calBusy, setCalBusy] = useState(false);
  const [calMsg, setCalMsg] = useState('');
  const [syncMsg, setSyncMsg] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [dedupeMsg, setDedupeMsg] = useState('');

  const [notifyEnabled, setNotifyEnabled] = useState(true);
  const [webhookOnComplete, setWebhookOnComplete] = useState(false);
  const [webhookDigest, setWebhookDigest] = useState(false);
  const [webhookDeadlines, setWebhookDeadlines] = useState(false);

  useEffect(() => {
    if (isSettingsModalOpen) {
      getSetting('pomo_work_mins', '25').then(setWorkMins);
      getSetting('pomo_short_break_mins', '5').then(setShortBreakMins);
      getSetting('pomo_long_break_mins', '15').then(setLongBreakMins);
      getSetting('pomo_auto_break', '0').then((v: string) => setAutoBreak(v === '1'));

      getSecret('int_discord').then(setDiscordHook);
      getSecret('int_slack').then(setSlackHook);
      getSecret('ai_api_key').then(setAiKey);
      getSetting('ai_provider', 'anthropic').then(setAiProvider);
      getSetting('ai_base_url', '').then(setAiBaseUrl);
      getSetting('ai_model', '').then(setAiModel);
      getSetting('quickadd_ai', '0').then((v: string) => setQuickAddAi(v === '1'));

      getSetting('work_start_min', '540').then((v: string) => setWorkStart(minToTime(Number(v) || 540)));
      getSetting('work_end_min', '1020').then((v: string) => setWorkEnd(minToTime(Number(v) || 1020)));
      getCalendarUrl().then(setCalUrl);

      getSetting('notify_enabled', '1').then((v: string) => setNotifyEnabled(v === '1'));
      getSetting('webhook_on_complete', '0').then((v: string) => setWebhookOnComplete(v === '1'));
      getSetting('webhook_digest', '0').then((v: string) => setWebhookDigest(v === '1'));
      getSetting('webhook_deadlines', '0').then((v: string) => setWebhookDeadlines(v === '1'));
    }
  }, [isSettingsModalOpen]);

  if (!isSettingsModalOpen) return null;

  const meta = PROVIDERS[aiProvider] || PROVIDERS.anthropic;

  const handleUpdateSetting = async (key: string, value: string) => {
    await setSetting(key, value);
    // Ideally update the state/pomodoro store directly
    window.dispatchEvent(new CustomEvent('settings-changed'));
  };

  const handleUpdateSecret = async (key: string, value: string) => {
    await setSecret(key, value);
    window.dispatchEvent(new CustomEvent('settings-changed'));
  };

  const saveWorkHours = async (startStr: string, endStr: string) => {
    const s = timeToMin(startStr);
    const e = timeToMin(endStr);
    if (e <= s) { setCalMsg('Work day must end after it starts.'); return; }
    setCalMsg('');
    await setSetting('work_start_min', String(s));
    await setSetting('work_end_min', String(e));
    window.dispatchEvent(new CustomEvent('settings-changed'));
  };

  const handleSyncCalendarUrl = async () => {
    setCalBusy(true);
    setCalMsg('');
    try {
      await setCalendarUrl(calUrl);
      const n = await syncCalendarUrl(calUrl);
      setCalMsg(`Imported ${n} busy event${n === 1 ? '' : 's'}.`);
      toast(`📅 Calendar synced — ${n} event${n === 1 ? '' : 's'}`);
    } catch (err: any) {
      setCalMsg(err?.message || 'Sync failed.');
    } finally {
      setCalBusy(false);
    }
  };

  const pasteBusyIcs = () => pickFile('.ics,text/calendar', async (text) => {
    try {
      const n = await importBusyText(text);
      setCalMsg(`Imported ${n} busy event${n === 1 ? '' : 's'} from file.`);
      toast(n ? `📅 Imported ${n} busy event${n === 1 ? '' : 's'}` : 'No timed events in that file');
    } catch (err: any) {
      setCalMsg(err?.message || 'Import failed.');
    }
  });

  const removeDuplicates = async () => {
    setDedupeMsg('Scanning…');
    try {
      const n = await dedupeTasks();
      await loadAllTasks(useStore.getState().currentFilter);
      setDedupeMsg(n > 0 ? `Removed ${n} duplicate task${n === 1 ? '' : 's'}.` : 'No duplicate tasks found.');
      toast(n > 0 ? `🧹 Removed ${n} duplicate${n === 1 ? '' : 's'}` : 'No duplicates found');
    } catch (err: any) {
      setDedupeMsg(`Cleanup failed: ${err?.message || err}`);
    }
  };

  const exportSyncBundle = async () => {
    setSyncBusy(true);
    try {
      const json = await exportBundle();
      downloadStr(json, `cognate-sync-${Date.now()}.json`, 'application/json');
      setSyncMsg('Bundle exported. Import it on another device to converge.');
      toast('🔀 Sync bundle exported');
    } catch (err: any) {
      setSyncMsg(err?.message || 'Export failed.');
    } finally {
      setSyncBusy(false);
    }
  };
  const importSyncBundle = () => pickFile('.json,application/json', async (text) => {
    setSyncBusy(true);
    setSyncMsg('');
    try {
      const r = await importBundle(text);
      setSyncMsg(`Merged ${r.applied} ops · ${r.upserts} task${r.upserts === 1 ? '' : 's'} updated, ${r.deletes} removed.`);
      toast(`🔀 Synced — ${r.upserts} updated, ${r.deletes} removed`);
    } catch (err: any) {
      setSyncMsg(err?.message || 'Import failed.');
    } finally {
      setSyncBusy(false);
    }
  });

  const exportCalendar = async () => {
    const tasks = await getAllTasks('all');
    const n = exportIcs(tasks as any);
    toast(`📅 Exported ${n} event${n === 1 ? '' : 's'} (.ics)`);
  };
  const importCalendar = () => pickFile('.ics,text/calendar', async (text) => {
    const n = await importIcsText(text);
    toast(n ? `📅 Imported ${n} event${n === 1 ? '' : 's'}` : 'No events found in that file');
  });
  const importData = () => pickFile('.json,.csv', async (text, name) => {
    const drafts = parseImport(name, text);
    if (!drafts.length) { toast('No tasks found in that file'); return; }
    const n = await importTasks(drafts);
    toast(`📥 Imported ${n} task${n === 1 ? '' : 's'}`);
  });

  const startOAuth = async (provider: string) => {
    try {
        if (!(window as any).__TAURI_INTERNALS__) {
            throw new Error('Not running inside Tauri window');
        }
        const { invoke } = await import('@tauri-apps/api/core');
        const { open } = await import('@tauri-apps/plugin-shell');
        const url: string = await invoke('start_oauth', { provider });
        await open(url);
    } catch (e: any) {
        console.error('OAuth initiation failed', e);
        alert(`Failed to connect calendar: ${e.message || String(e)}`);
    }
  };

  return (
    <div ref={panelRef} className={`side-panel ${isSettingsModalOpen ? 'open' : ''}`} role="dialog" aria-modal="true" aria-label="Settings">
      <div className="panel-header">
        <h2>Settings</h2>
        <button className="btn-icon" onClick={() => setSettingsModalOpen(false)}>
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div className="panel-body">

        <LanguageSelect />

        <div className="settings-section">
          <h3>Timer</h3>
          <div className="form-group row">
            <label>Work Session (m)</label>
            <input type="number" value={workMins} onChange={e => {
              setWorkMins(e.target.value);
              handleUpdateSetting('pomo_work_mins', e.target.value);
            }} min="1" max="120" />
          </div>
          <div className="form-group row">
            <label>Short Break (m)</label>
            <input type="number" value={shortBreakMins} onChange={e => {
              setShortBreakMins(e.target.value);
              handleUpdateSetting('pomo_short_break_mins', e.target.value);
            }} min="1" max="30" />
          </div>
          <div className="form-group row">
            <label>Long Break (m)</label>
            <input type="number" value={longBreakMins} onChange={e => {
              setLongBreakMins(e.target.value);
              handleUpdateSetting('pomo_long_break_mins', e.target.value);
            }} min="1" max="60" />
          </div>
          
          <div className="form-group row switch-row">
            <label>Auto-start Breaks</label>
            <label className="switch">
              <input type="checkbox" checked={autoBreak} onChange={e => {
                setAutoBreak(e.target.checked);
                handleUpdateSetting('pomo_auto_break', e.target.checked ? '1' : '0');
              }} />
              <span className="slider"></span>
            </label>
          </div>
        </div>

        <div className="settings-section">
          <h3>AI Assistant</h3>

          <div className="form-group">
            <button className="btn-soft" onClick={async () => {
              const p = await enablePrivateAi();
              setAiProvider(p.provider); setAiBaseUrl(p.baseUrl); setAiModel(p.model);
              toast('🔒 Private mode — AI now runs locally');
            }}>
              <i className="fa-solid fa-shield-halved"></i> Go fully private (Ollama)
            </button>
            <small className="form-hint">
              One click points planning, quick-add, and advice at a local model — nothing leaves your device.
              Needs <a href="https://ollama.com" target="_blank" rel="noreferrer">Ollama</a> running locally.
            </small>
          </div>

          <div className="form-group">
            <label>Provider</label>
            <select value={aiProvider} onChange={e => {
              setAiProvider(e.target.value);
              handleUpdateSetting('ai_provider', e.target.value);
            }}>
              {Object.entries(PROVIDERS).map(([id, p]) => (
                <option key={id} value={id}>{p.label}</option>
              ))}
            </select>
            <small className="form-hint">
              Use any Claude, OpenAI-compatible, or local model (Ollama, llama.cpp, self-hosted).
            </small>
          </div>

          <div className="form-group">
            <label>API Key {!meta.needsKey && <span className="opt-tag">optional</span>}</label>
            <input type="password" value={aiKey} onChange={e => {
              setAiKey(e.target.value);
              handleUpdateSecret('ai_api_key', e.target.value);
            }} placeholder={meta.needsKey ? 'sk-…' : 'usually not needed for local'} autoComplete="off" />
            <small className="form-hint">
              Stored in your OS keychain{meta.keyHint ? ` · get a key at ${meta.keyHint}` : ''}.
            </small>
          </div>

          {aiProvider !== 'anthropic' && (
            <div className="form-group">
              <label>Base URL</label>
              <input type="url" value={aiBaseUrl} onChange={e => {
                setAiBaseUrl(e.target.value);
                handleUpdateSetting('ai_base_url', e.target.value);
              }} placeholder={meta.base || 'https://your-server/v1'} autoComplete="off" />
              <small className="form-hint">Leave blank to use the provider default.</small>
            </div>
          )}

          <div className="form-group">
            <label>Model</label>
            <input type="text" value={aiModel} onChange={e => {
              setAiModel(e.target.value);
              handleUpdateSetting('ai_model', e.target.value);
            }} placeholder={meta.model ? `${meta.model}${aiProvider === 'anthropic' ? ' (default)' : ''}` : 'model name'} autoComplete="off" />
          </div>

          <div className="form-group row switch-row">
            <label>Smart quick-add <span className="opt-tag">AI</span></label>
            <label className="switch">
              <input type="checkbox" checked={quickAddAi}
                onChange={(e) => { setQuickAddAi(e.target.checked); handleUpdateSetting('quickadd_ai', e.target.checked ? '1' : '0'); }} />
              <span className="slider"></span>
            </label>
          </div>
          <small className="form-hint">
            When on, ⌘K quick-add uses AI to fill anything the fast parser misses. Off = fully deterministic + offline.
          </small>
        </div>

        <div className="settings-section">
          <h3>Notifications</h3>
          <div className="form-group row switch-row">
            <label>Desktop notifications</label>
            <label className="switch">
              <input type="checkbox" checked={notifyEnabled} onChange={e => {
                setNotifyEnabled(e.target.checked);
                handleUpdateSetting('notify_enabled', e.target.checked ? '1' : '0');
              }} />
              <span className="slider"></span>
            </label>
          </div>
          <small className="form-hint">Focus-session end and tasks due today / overdue.</small>
        </div>

        <div className="settings-section">
          <h3>Custom Fields</h3>
          {customFieldDefs.length > 0 && (
            <div className="cf-list">
              {customFieldDefs.map((f) => (
                <div className="cf-item" key={f.id}>
                  <span className="cf-name">{f.name}</span>
                  <span className="cf-type">{f.type}</span>
                  <button className="cf-del" onClick={() => removeCustomField(f.id)} title="Remove">
                    <i className="fa-solid fa-xmark"></i>
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="cf-add">
            <input type="text" placeholder="Field name" value={cfName} onChange={(e) => setCfName(e.target.value)} />
            <select value={cfType} onChange={(e) => setCfType(e.target.value as CustomFieldType)}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="url">URL</option>
              <option value="date">Date</option>
              <option value="select">Select</option>
            </select>
            <button className="btn-soft" onClick={addCustomField}><i className="fa-solid fa-plus"></i> Add</button>
          </div>
          {cfType === 'select' && (
            <input className="cf-options" type="text" placeholder="Options, comma-separated" value={cfOptions} onChange={(e) => setCfOptions(e.target.value)} />
          )}
          <small className="form-hint">Custom fields appear in the task editor and the Table view.</small>
        </div>

        <div className="settings-section">
          <h3>Integrations</h3>

          <div className="form-group">
            <label>Discord Webhook</label>
            <input type="url" value={discordHook} onChange={e => {
              setDiscordHook(e.target.value);
              handleUpdateSecret('int_discord', e.target.value);
            }} placeholder="https://discord.com/api/webhooks/..." />
          </div>

          <div className="form-group">
            <label>Slack Webhook</label>
            <input type="url" value={slackHook} onChange={e => {
              setSlackHook(e.target.value);
              handleUpdateSecret('int_slack', e.target.value);
            }} placeholder="https://hooks.slack.com/services/..." />
          </div>

          <div className="form-group row switch-row">
            <label>Post to webhooks when a task is completed</label>
            <label className="switch">
              <input type="checkbox" checked={webhookOnComplete} onChange={e => {
                setWebhookOnComplete(e.target.checked);
                handleUpdateSetting('webhook_on_complete', e.target.checked ? '1' : '0');
              }} />
              <span className="slider"></span>
            </label>
          </div>

          <div className="form-group row switch-row">
            <label>Deadline alerts to webhooks (due today / overdue)</label>
            <label className="switch">
              <input type="checkbox" checked={webhookDeadlines} onChange={e => {
                setWebhookDeadlines(e.target.checked);
                handleUpdateSetting('webhook_deadlines', e.target.checked ? '1' : '0');
              }} />
              <span className="slider"></span>
            </label>
          </div>

          <div className="form-group row switch-row">
            <label>Daily digest to webhooks</label>
            <label className="switch">
              <input type="checkbox" checked={webhookDigest} onChange={e => {
                setWebhookDigest(e.target.checked);
                handleUpdateSetting('webhook_digest', e.target.checked ? '1' : '0');
              }} />
              <span className="slider"></span>
            </label>
          </div>

          <div className="oauth-buttons">
            <button className="btn-oauth google" onClick={() => startOAuth('google')}>
              <i className="fa-brands fa-google"></i> Connect Google Calendar
            </button>
            <button className="btn-oauth outlook" onClick={() => startOAuth('microsoft')}>
              <i className="fa-brands fa-microsoft"></i> Connect Outlook Calendar
            </button>
          </div>
        </div>

        <BackupsSection />

        <UpdatesSection />

        <div className="settings-section">
          <h3>Calendar &amp; Planning</h3>

          <div className="form-group row">
            <label>Work day starts</label>
            <input type="time" value={workStart} onChange={(e) => { setWorkStart(e.target.value); saveWorkHours(e.target.value, workEnd); }} />
          </div>
          <div className="form-group row">
            <label>Work day ends</label>
            <input type="time" value={workEnd} onChange={(e) => { setWorkEnd(e.target.value); saveWorkHours(workStart, e.target.value); }} />
          </div>
          <small className="form-hint">The planner only schedules work inside these hours.</small>

          <div className="form-group">
            <label>Calendar subscription (.ics URL)</label>
            <input
              type="url"
              value={calUrl}
              onChange={(e) => setCalUrl(e.target.value)}
              onBlur={() => setCalendarUrl(calUrl)}
              placeholder="https://calendar.google.com/…/basic.ics or webcal://…"
              autoComplete="off"
            />
            <small className="form-hint">
              Your meetings become busy blocks the planner schedules around. Read-only — Cognate never writes to your calendar.
            </small>
          </div>

          <div className="sync-grid">
            <button className="btn-soft" onClick={handleSyncCalendarUrl} disabled={calBusy || !calUrl.trim()}>
              <i className={`fa-solid ${calBusy ? 'fa-spinner fa-spin' : 'fa-rotate'}`}></i> {IS_TAURI ? 'Sync now' : 'Sync (desktop)'}
            </button>
            <button className="btn-soft" onClick={pasteBusyIcs}>
              <i className="fa-solid fa-calendar-plus"></i> Import .ics file
            </button>
          </div>
          {calMsg && <small className="form-hint">{calMsg}</small>}
          {!IS_TAURI && (
            <small className="form-hint">Subscribing to a URL needs the desktop app (browsers block cross-site calendar fetches). Import an .ics file here instead.</small>
          )}

          <CalendarAccount />
        </div>

        <div className="settings-section">
          <h3>Housekeeping</h3>
          <button className="btn-soft" onClick={removeDuplicates}>
            <i className="fa-solid fa-broom"></i> Remove duplicate tasks
          </button>
          {dedupeMsg && <small className="form-hint">{dedupeMsg}</small>}
          <small className="form-hint">
            Cleans up exact-duplicate tasks (e.g. from an earlier seeding bug), keeping the most-complete copy.
            Distinct tasks and anything in Trash are left untouched.
          </small>
        </div>

        <LiveSyncSettings />

        <SharedProjects />

        <div className="settings-section">
          <h3>Device sync <span className="opt-tag">beta</span></h3>
          <div className="sync-grid">
            <button className="btn-soft" onClick={exportSyncBundle} disabled={syncBusy}>
              <i className="fa-solid fa-file-export"></i> Export sync bundle
            </button>
            <button className="btn-soft" onClick={importSyncBundle} disabled={syncBusy}>
              <i className="fa-solid fa-file-import"></i> Import &amp; merge
            </button>
          </div>
          {syncMsg && <small className="form-hint">{syncMsg}</small>}
          <small className="form-hint">
            Move your tasks between devices with a portable, conflict-free bundle. Edits merge automatically —
            no server, no account. (End-to-end-encrypted live sync is coming.)
          </small>
        </div>

        <div className="settings-section">
          <h3>Sync &amp; Import</h3>
          <div className="sync-grid">
            <button className="btn-soft" onClick={exportCalendar}>
              <i className="fa-regular fa-calendar"></i> Export .ics
            </button>
            <button className="btn-soft" onClick={importCalendar}>
              <i className="fa-solid fa-calendar-plus"></i> Import .ics
            </button>
            <button className="btn-soft" onClick={importData}>
              <i className="fa-solid fa-file-import"></i> Import tasks
            </button>
          </div>
          <small className="form-hint">
            Export deadlines to any calendar (Google / Outlook / Apple) via .ics.
            Import tasks from Todoist, Trello, CSV, or JSON exports.
          </small>
        </div>

      </div>
    </div>
  );
}
