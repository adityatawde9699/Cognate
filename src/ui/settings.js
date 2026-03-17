/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/settings.js — App Settings (M4)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { state } from '../state.js';
import { getSetting, setSetting } from '../db.js';

export async function initSettings() {
    // Load
    const workMins = await getSetting('pomo_work_mins', '25');
    const shortBreakMins = await getSetting('pomo_short_break_mins', '5');
    const longBreakMins = await getSetting('pomo_long_break_mins', '15');
    const autoBreak = await getSetting('pomo_auto_break', '0');

    // Integrations
    const discordHook = await getSetting('int_discord', '');
    const slackHook = await getSetting('int_slack', '');
    const tgToken = await getSetting('int_tg_token', '');
    const tgChat = await getSetting('int_tg_chat', '');

    state.settings.workSecs = parseInt(workMins, 10) * 60;
    state.settings.shortBreakSecs = parseInt(shortBreakMins, 10) * 60;
    state.settings.longBreakSecs = parseInt(longBreakMins, 10) * 60;
    state.settings.autoStartBreak = autoBreak === '1';

    // Bind UI
    const sWork = document.getElementById('setWorkMins');
    const sShort = document.getElementById('setShortMins');
    const sLong = document.getElementById('setLongMins');
    const sAuto = document.getElementById('setAutoBreak');
    
    // Integrations
    const iDiscord = document.getElementById('setDiscord');
    const iSlack = document.getElementById('setSlack');
    const iTgToken = document.getElementById('setTgToken');
    const iTgChat = document.getElementById('setTgChat');

    if (sWork) sWork.value = workMins;
    if (sShort) sShort.value = shortBreakMins;
    if (sLong) sLong.value = longBreakMins;
    if (sAuto) sAuto.checked = state.settings.autoStartBreak;
    
    if (iDiscord) iDiscord.value = discordHook;
    if (iSlack) iSlack.value = slackHook;
    if (iTgToken) iTgToken.value = tgToken;
    if (iTgChat) iTgChat.value = tgChat;

    document.getElementById('btnSettings').addEventListener('click', () => {
        document.getElementById('settingsPanel').classList.remove('hidden');
    });
    document.getElementById('closeSettings').addEventListener('click', () => {
        document.getElementById('settingsPanel').classList.add('hidden');
    });

    // Listeners for changes
    if (sWork) sWork.addEventListener('change', async (e) => {
        const v = e.target.value;
        await setSetting('pomo_work_mins', v);
        state.settings.workSecs = parseInt(v, 10) * 60;
        if (state.pomoMode === 'work' && !state.pomoRunning) {
            state.pomoSeconds = state.settings.workSecs;
        }
    });
    if (sShort) sShort.addEventListener('change', async (e) => {
        const v = e.target.value;
        await setSetting('pomo_short_break_mins', v);
        state.settings.shortBreakSecs = parseInt(v, 10) * 60;
    });
    if (sLong) sLong.addEventListener('change', async (e) => {
        const v = e.target.value;
        await setSetting('pomo_long_break_mins', v);
        state.settings.longBreakSecs = parseInt(v, 10) * 60;
    });
    if (sAuto) sAuto.addEventListener('change', async (e) => {
        const v = e.target.checked;
        await setSetting('pomo_auto_break', v ? '1' : '0');
        state.settings.autoStartBreak = v;
    });

    // Integration Setting Listeners
    if (iDiscord) iDiscord.addEventListener('change', e => setSetting('int_discord', e.target.value.trim()));
    if (iSlack) iSlack.addEventListener('change', e => setSetting('int_slack', e.target.value.trim()));
    if (iTgToken) iTgToken.addEventListener('change', e => setSetting('int_tg_token', e.target.value.trim()));
    if (iTgChat) iTgChat.addEventListener('change', e => setSetting('int_tg_chat', e.target.value.trim()));

    // OAuth Listeners
    const btnGoogle = document.getElementById('btnGoogleCal');
    const btnOutlook = document.getElementById('btnOutlookCal');
    
    const startOAuth = async (provider) => {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            const { open } = await import('@tauri-apps/plugin-shell');
            const url = await invoke('start_oauth', { provider });
            await open(url); // open system browser to auth page
        } catch (e) {
            console.error('OAuth initiation failed', e);
        }
    };

    if (btnGoogle) btnGoogle.addEventListener('click', () => startOAuth('google'));
    if (btnOutlook) btnOutlook.addEventListener('click', () => startOAuth('microsoft'));
}
