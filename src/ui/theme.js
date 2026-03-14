/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/theme.js — Theme management
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { state } from '../state.js';

export function toggleTheme() {
    const html = document.documentElement;
    const theme = html.dataset.theme === 'light' ? 'dark' : 'light';
    html.dataset.theme = theme;
    localStorage.setItem('cn_theme', theme);

    // Update chart if it exists
    if (state.weekChart) {
        const isDark = theme !== 'light';
        const gridColor = isDark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.06)';
        const tickColor = isDark ? '#7b7f9a' : '#5c5f78';
        state.weekChart.options.scales.x.grid.color = gridColor;
        state.weekChart.options.scales.y.grid.color = gridColor;
        state.weekChart.options.scales.x.ticks.color = tickColor;
        state.weekChart.options.scales.y.ticks.color = tickColor;
        state.weekChart.update();
    }
}

export function initTheme() {
    const savedTheme = localStorage.getItem('cn_theme') || 'dark';
    document.documentElement.dataset.theme = savedTheme;
    document.getElementById('btnTheme').addEventListener('click', toggleTheme);
}
