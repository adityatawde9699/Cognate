/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/pomodoro.js — Pomodoro Timer (S7)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { state } from '../state.js';
import { addPomodoro, IS_TAURI } from '../db.js';
import { toast } from '../utils/toast.js';
import { info } from '../logger.js';

let _refreshCb = null;
const CIRC = 2 * Math.PI * 17; // ring circumference

function $(id) { return document.getElementById(id); }

export function updatePomoDisplay() {
    const m = String(Math.floor(state.pomoSeconds / 60)).padStart(2, '0');
    const s = String(state.pomoSeconds % 60).padStart(2, '0');
    const elTime = $('pomoTime');
    if (elTime) elTime.textContent = `${m}:${s}`;

    // Calculate total duration for progress ring based on mode
    let dur = state.settings.workSecs;
    if (state.pomoMode === 'short-break') dur = state.settings.shortBreakSecs;
    if (state.pomoMode === 'long-break') dur = state.settings.longBreakSecs;

    const progress = (dur - state.pomoSeconds) / dur;
    const elFg = $('pomoFg');
    if (elFg) elFg.setAttribute('stroke-dashoffset', CIRC - progress * CIRC);

    // Update Mode indicator
    const elMode = $('pomoMode');
    if (elMode) {
        if (state.pomoMode === 'work') elMode.textContent = 'Focus';
        else if (state.pomoMode === 'short-break') elMode.textContent = 'Short Break';
        else elMode.textContent = 'Long Break';
    }
}

export function selectPomoTask(task) {
    if (state.pomoRunning) pausePomo();
    state.pomoTaskId = task.id;
    const elTask = $('pomoTask');
    if (elTask) elTask.textContent = task.title;

    // When selecting a task, always reset to Work mode
    state.pomoMode = 'work';
    resetPomo();

    document.querySelectorAll('.btn-focus-sel').forEach(b =>
        b.classList.toggle('active', b.dataset.id === task.id));
}

export function resetPomo() {
    clearInterval(state.pomoTimerID);
    state.pomoRunning = false;

    if (state.pomoMode === 'work') state.pomoSeconds = state.settings.workSecs;
    else if (state.pomoMode === 'short-break') state.pomoSeconds = state.settings.shortBreakSecs;
    else state.pomoSeconds = state.settings.longBreakSecs;

    updatePomoDisplay();
    const elStart = $('pomoStart');
    if (elStart) elStart.innerHTML = '<i class="fa-solid fa-play"></i>';
}

function pausePomo() {
    clearInterval(state.pomoTimerID);
    state.pomoRunning = false;
    const elStart = $('pomoStart');
    if (elStart) elStart.innerHTML = '<i class="fa-solid fa-play"></i>';
}

async function startPomo() {
    if (state.pomoMode === 'work' && !state.pomoTaskId) {
        toast('⚠️ Select a task first');
        return;
    }
    state.pomoRunning = true;
    const elStart = $('pomoStart');
    if (elStart) elStart.innerHTML = '<i class="fa-solid fa-pause"></i>';

    state.pomoTimerID = setInterval(async () => {
        state.pomoSeconds--;
        updatePomoDisplay();

        if (state.pomoSeconds <= 0) {
            clearInterval(state.pomoTimerID);
            state.pomoRunning = false;

            if (state.pomoMode === 'work') {
                // Done with work session
                state.pomoSessionCount++;
                await addPomodoro(state.pomoTaskId);
                if (_refreshCb) _refreshCb();

                info(`Pomodoro complete: ${state.pomoTaskId}`);
                notifyOS('🍅 Pomodoro Complete!', 'Great work! Time for a break.');

                // Determine next break mode
                if (state.pomoSessionCount % 4 === 0) {
                    state.pomoMode = 'long-break';
                } else {
                    state.pomoMode = 'short-break';
                }
                resetPomo();
                if (state.settings.autoStartBreak) startPomo();

            } else {
                // Done with break
                notifyOS('⏰ Break Over!', 'Ready to focus again?');
                state.pomoMode = 'work';
                resetPomo();
                // Optionally auto-start work here, but usually users want to manually start work
            }
        }
    }, 1000);
}

async function notifyOS(title, body) {
    if (!state.settings.soundEnabled) {
        // We could implement silent notifications here
    }

    if (IS_TAURI) {
        try {
            const { isPermissionGranted, requestPermission, sendNotification } =
                await import('@tauri-apps/plugin-notification');
            let ok = await isPermissionGranted();
            if (!ok) { const perm = await requestPermission(); ok = perm === 'granted'; }
            if (ok) sendNotification({ title, body });
        } catch (_) { }
    } else {
        toast(title);
    }
}

export function initPomodoro(refreshCb) {
    _refreshCb = refreshCb;
    const elStart = $('pomoStart');
    if (elStart) elStart.addEventListener('click', () => state.pomoRunning ? pausePomo() : startPomo());
    const elReset = $('pomoReset');
    if (elReset) elReset.addEventListener('click', resetPomo);

    // Add mode indicator to HTML if not present
    const chip = $('pomoChip');
    if (chip && !$('pomoMode')) {
        const meta = chip.querySelector('.pomo-meta');
        if (meta) {
            const modeEl = document.createElement('span');
            modeEl.id = 'pomoMode';
            modeEl.className = 'pomo-mode-badge';
            modeEl.textContent = 'Focus';
            meta.insertBefore(modeEl, meta.firstChild);
        }
    }

    resetPomo();
}
