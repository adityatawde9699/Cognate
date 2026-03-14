/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/nav.js — Sidebar Navigation
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { state } from '../state.js';

let _refreshCb = null;

const FILTER_META = {
    all: ['All Tasks', 'Showing all tasks, ordered by priority'],
    today: ['Due Today', "Tasks with today's deadline"],
    high: ['High Priority', 'Only urgent, high-impact tasks'],
};

export function setFilter(filter) {
    if (filter.startsWith('tag:')) {
        document.querySelectorAll('.nav-btn[data-filter]').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.mob-btn[data-filter]').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tag-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tag === filter.split(':')[1]));
    } else {
        document.querySelectorAll('.tag-nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.nav-btn[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
        document.querySelectorAll('.mob-btn[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === filter));
    }

    state.currentFilter = filter;
    if (_refreshCb) _refreshCb();
}

export function initNav(refreshCb) {
    _refreshCb = refreshCb;
    document.querySelectorAll('.nav-btn[data-filter]').forEach(btn =>
        btn.addEventListener('click', () => setFilter(btn.dataset.filter)));
    document.querySelectorAll('.mob-btn[data-filter]').forEach(btn =>
        btn.addEventListener('click', () => setFilter(btn.dataset.filter)));
}
