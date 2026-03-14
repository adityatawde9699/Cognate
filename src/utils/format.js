/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/utils/format.js — Display helpers
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
'use strict';

export const P_LABEL = { high: '🔴 High', medium: '🟡 Medium', low: '🟢 Low' };
export const P_COLOR = { high: 'var(--danger)', medium: 'var(--accent)', low: 'var(--success)' };

export function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function isOverdue(iso) {
    if (!iso) return false;
    return new Date(iso + 'T00:00:00') < new Date(new Date().toDateString());
}

export function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
