/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/state.js — Shared Application State
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
'use strict';

export const state = {
    // Tasks
    currentTasks: [],
    currentFilter: 'all',

    // Pomodoro
    pomoTaskId: null,
    pomoMode: 'work', // 'work' | 'short-break' | 'long-break'
    pomoSeconds: 25 * 60,
    pomoRunning: false,
    pomoTimerID: null,
    pomoSessionCount: 0,

    // Analytics
    weekChart: null,

    // Settings (populated by initSettings)
    settings: {
        workSecs: 25 * 60,
        shortBreakSecs: 5 * 60,
        longBreakSecs: 15 * 60,
        autoStartBreak: false,
        soundEnabled: true,
    },
};
