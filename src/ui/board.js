/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/board.js — Kanban Board & DnD
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { state } from '../state.js';
import { toggleTask, deleteTask, updateSortOrders } from '../db.js';
import { toast } from '../utils/toast.js';
import { P_LABEL, P_COLOR, fmtDate, isOverdue, esc } from '../utils/format.js';
import { selectPomoTask, resetPomo } from './pomodoro.js';
import { openModal } from './modal.js';

let _refreshCb = null;

function $(id) { return document.getElementById(id); }

export function filterBySearch(tasks) {
    const elSearch = $('searchInput');
    const q = (elSearch ? elSearch.value : '').toLowerCase().trim();
    if (!q) return tasks;
    return tasks.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.tags || []).some(tag => tag.toLowerCase().includes(q))
    );
}

function buildCard(task) {
    const card = document.createElement('div');
    card.className = `task-card${task.done ? ' done-card' : ''}`;
    card.dataset.id = task.id;
    card.dataset.priority = task.priority;
    card.draggable = true;

    const dots = Array.from({ length: Math.min(task.pomodorosSpent || 0, 8) })
        .map(() => '<div class="pomo-dot"></div>').join('');
    const tags = (task.tags || []).filter(Boolean)
        .map(t => `<span class="tag">${esc(t.trim())}</span>`).join('');
    const dl = task.deadline
        ? `<span class="deadline-lbl${isOverdue(task.deadline) && !task.done ? ' overdue' : ''}">
         <i class="fa-regular fa-calendar"></i> ${fmtDate(task.deadline)}
       </span>`
        : '';

    const isPomoSel = state.pomoTaskId === task.id && !task.done;

    card.innerHTML = `
    <div class="card-top">
      <div class="card-check${task.done ? ' checked' : ''}" data-id="${task.id}">
        <i class="fa-solid fa-check"></i>
      </div>
      <span class="card-title">${esc(task.title)}</span>
      <div class="card-actions">
        <button class="icon-btn btn-focus-sel${isPomoSel ? ' active' : ''}" data-id="${task.id}" title="Focus (Pomodoro)">
          <i class="fa-solid fa-stopwatch"></i>
        </button>
        <button class="icon-btn btn-edit" data-id="${task.id}" title="Edit">
          <i class="fa-solid fa-pen-to-square"></i>
        </button>
        <button class="icon-btn del btn-del" data-id="${task.id}" title="Delete">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>
    </div>
    ${task.description ? `<p class="card-desc">${esc(task.description)}</p>` : ''}
    <div class="card-footer">
      <span class="p-badge ${task.priority}">${P_LABEL[task.priority] || task.priority}</span>
      ${tags}
      ${dl}
      ${dots ? `<div class="pomo-dots">${dots}</div>` : ''}
    </div>`;

    // Events
    card.querySelector('.card-check').addEventListener('click', async () => {
        await toggleTask(task.id);
        if (_refreshCb) _refreshCb();
        toast('Task updated ✓');
    });
    card.querySelector('.btn-edit').addEventListener('click', () => openModal(task));
    card.querySelector('.btn-del').addEventListener('click', async () => {
        await deleteTask(task.id);
        if (state.pomoTaskId === task.id) resetPomo();
        if (_refreshCb) _refreshCb();
        toast('🗑️ Task deleted');
    });
    card.querySelector('.btn-focus-sel').addEventListener('click', () => selectPomoTask(task));

    // Drag-and-drop
    card.addEventListener('dragstart', () => { window._cnDragId = task.id; card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', async e => {
        e.preventDefault();
        card.classList.remove('drag-over');
        await reorder(window._cnDragId, task.id);
    });

    return card;
}

export function renderBoard(tasks) {
    const pending = tasks.filter(t => !t.done);
    const done = tasks.filter(t => t.done);

    const pl = $('pendingList'); const dl = $('doneList');
    if (pl) pl.querySelectorAll('.task-card').forEach(c => c.remove());
    if (dl) dl.querySelectorAll('.task-card').forEach(c => c.remove());

    if (pl) pending.forEach(t => pl.appendChild(buildCard(t)));
    if (dl) done.forEach(t => dl.appendChild(buildCard(t)));

    if ($('pendingCount')) $('pendingCount').textContent = pending.length;
    if ($('doneCount')) $('doneCount').textContent = done.length;

    if ($('skeletonGroup')) $('skeletonGroup').classList.add('hidden');
    if ($('emptyPending')) $('emptyPending').classList.toggle('hidden', pending.length > 0);
    if ($('emptyDone')) $('emptyDone').classList.toggle('hidden', done.length > 0);
}

// DnD Reorder + S2 SQLite persistence
export async function reorder(fromId, toId) {
    if (fromId === toId) return;
    const fi = state.currentTasks.findIndex(t => t.id === fromId);
    const ti = state.currentTasks.findIndex(t => t.id === toId);
    if (fi < 0 || ti < 0) return;

    // Memory update
    const [moved] = state.currentTasks.splice(fi, 1);
    state.currentTasks.splice(ti, 0, moved);

    // Visual update
    renderBoard(filterBySearch(state.currentTasks));

    // DB persistence
    // Extract ordered IDs from the current filter view in memory
    const orderedIds = state.currentTasks.map(t => t.id);
    await updateSortOrders(orderedIds);
}

export function initBoard(refreshCb) {
    _refreshCb = refreshCb;
    const searchInput = $('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            renderBoard(filterBySearch(state.currentTasks));
        });
    }
}
