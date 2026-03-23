import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { getSetting, setSetting } from '../../db';

export function SettingsModal() {
  const { isSettingsModalOpen, setSettingsModalOpen } = useStore();

  const [workMins, setWorkMins] = useState('25');
  const [shortBreakMins, setShortBreakMins] = useState('5');
  const [longBreakMins, setLongBreakMins] = useState('15');
  const [autoBreak, setAutoBreak] = useState(false);

  const [discordHook, setDiscordHook] = useState('');
  const [slackHook, setSlackHook] = useState('');
  const [tgToken, setTgToken] = useState('');
  const [tgChat, setTgChat] = useState('');

  useEffect(() => {
    if (isSettingsModalOpen) {
      getSetting('pomo_work_mins', '25').then(setWorkMins);
      getSetting('pomo_short_break_mins', '5').then(setShortBreakMins);
      getSetting('pomo_long_break_mins', '15').then(setLongBreakMins);
      getSetting('pomo_auto_break', '0').then((v: string) => setAutoBreak(v === '1'));
      
      getSetting('int_discord', '').then(setDiscordHook);
      getSetting('int_slack', '').then(setSlackHook);
      getSetting('int_tg_token', '').then(setTgToken);
      getSetting('int_tg_chat', '').then(setTgChat);
    }
  }, [isSettingsModalOpen]);

  if (!isSettingsModalOpen) return null;

  const handleUpdateSetting = async (key: string, value: string) => {
    await setSetting(key, value);
    // Ideally update the state/pomodoro store directly
    window.dispatchEvent(new CustomEvent('settings-changed'));
  };

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
    <div className={`side-panel ${isSettingsModalOpen ? 'open' : ''}`}>
      <div className="panel-header">
        <h2>Settings</h2>
        <button className="btn-icon" onClick={() => setSettingsModalOpen(false)}>
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>

      <div className="panel-body">
        
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
          <h3>Integrations</h3>
          
          <div className="form-group">
            <label>Discord Webhook</label>
            <input type="url" value={discordHook} onChange={e => {
              setDiscordHook(e.target.value);
              handleUpdateSetting('int_discord', e.target.value);
            }} placeholder="https://discord.com/api/webhooks/..." />
          </div>

          <div className="form-group">
            <label>Slack Webhook</label>
            <input type="url" value={slackHook} onChange={e => {
              setSlackHook(e.target.value);
              handleUpdateSetting('int_slack', e.target.value);
            }} placeholder="https://hooks.slack.com/services/..." />
          </div>

          <div className="form-group">
            <label>Telegram Bot Token</label>
            <input type="text" value={tgToken} onChange={e => {
              setTgToken(e.target.value);
              handleUpdateSetting('int_tg_token', e.target.value);
            }} placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
          </div>

          <div className="form-group">
            <label>Telegram Chat ID</label>
            <input type="text" value={tgChat} onChange={e => {
              setTgChat(e.target.value);
              handleUpdateSetting('int_tg_chat', e.target.value);
            }} placeholder="-1001234567890" />
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

      </div>
    </div>
  );
}
