/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/shortcuts.js — Global keyboard shortcuts
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { setFilter } from './nav.js';
import { toggleTheme } from './theme.js';
import { toggleAnalytics } from './analytics.js';

let _openModalCb = null;

export function initShortcuts(openModalCb) {
    _openModalCb = openModalCb;

    document.getElementById('btnShortcuts').addEventListener('click', () =>
        document.getElementById('shortcutsOverlay').classList.remove('hidden'));
    document.getElementById('closeShortcuts').addEventListener('click', () =>
        document.getElementById('shortcutsOverlay').classList.add('hidden'));

    document.addEventListener('keydown', e => {
        const tag = document.activeElement?.tagName?.toLowerCase();
        const inInput = ['input', 'textarea'].includes(tag);

        if (e.key === 'Escape') {
            document.getElementById('modalOverlay').classList.remove('open');
            document.getElementById('analyticsPanel').classList.add('hidden');
            document.getElementById('settingsPanel').classList.add('hidden');
            document.getElementById('nav-analytics').classList.remove('active');
            document.getElementById('shortcutsOverlay').classList.add('hidden');
            document.getElementById('searchInput').blur();
            return;
        }
        if (inInput) return;

        switch (e.key) {
            case 'n': case 'N': if (_openModalCb) _openModalCb(); break;
            case '/': e.preventDefault(); document.getElementById('searchInput').focus(); break;
            case '1': setFilter('all'); break;
            case '2': setFilter('today'); break;
            case '3': setFilter('high'); break;
            case 'a': case 'A': toggleAnalytics(); break;
            case 't': case 'T': toggleTheme(); break;
            case '?': document.getElementById('shortcutsOverlay').classList.toggle('hidden'); break;
        }
    });
}
