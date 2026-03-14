/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/app.js — Cognote Application Logic
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
'use strict';

import { initDb, getAllTasks } from './db.js';
import { state } from './state.js';
import { initTheme } from './ui/theme.js';
import { initWindowControls } from './ui/windowControls.js';
import { initSettings } from './ui/settings.js';
import { initAnalytics, refreshStats } from './ui/analytics.js';
import { initNav } from './ui/nav.js';
import { renderTagsNav } from './ui/tags.js';
import { initShortcuts } from './ui/shortcuts.js';
import { initModal, openModal } from './ui/modal.js';
import { initPomodoro, updatePomoDisplay } from './ui/pomodoro.js';
import { initBoard, renderBoard, filterBySearch } from './ui/board.js';
import { error as logError } from './logger.js';

// ── Load and refresh ──────────────────────────────────────
async function refresh() {
    state.currentTasks = await getAllTasks(state.currentFilter);
    const visible = filterBySearch(state.currentTasks);
    renderBoard(visible);
    renderTagsNav(); // M5 tag chip re-render
    await refreshStats();
}

// ── Bootstrap ─────────────────────────────────────────────
export async function initApp() {
    // 1. Theme + OS integrations
    initTheme();
    await initWindowControls();

    // 2. Data source init
    try {
        await initDb();
    } catch (err) {
        logError(`DB initialization failed: ${err.message}`);
        const errMsg = document.getElementById('errMsg');
        const errScreen = document.getElementById('errorScreen');
        if (errMsg && errScreen) {
            errMsg.textContent = String(err);
            errScreen.classList.remove('hidden');
        }
        return; // Halt startup
    }

    // 3. Load user settings
    await initSettings();

    // 4. Wire modules
    initNav(refresh);
    initShortcuts(openModal);
    initModal(refresh);
    initPomodoro(refresh);
    initBoard(refresh);
    initAnalytics();

    // 5. Initial paint
    await refresh();
    updatePomoDisplay();
}
