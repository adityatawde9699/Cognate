/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/modal.js — Task Add / Edit Modal
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { calcPriority, createTask, updateTask } from '../db.js';
import { toast } from '../utils/toast.js';
import { P_LABEL, P_COLOR } from '../utils/format.js';

let _refreshCb = null;

function $(id) { return document.getElementById(id); }

export function openModal(task = null) {
    const form = $('taskForm');
    if (form) form.reset();

    const elId = $('editId');
    if (elId) elId.value = task?.id ?? '';

    const modalTitle = $('modalTitle');
    if (modalTitle) modalTitle.textContent = task ? 'Edit Task' : 'New Task';

    if (task) {
        $('fTitle').value = task.title;
        $('fDesc').value = task.description || '';
        $('fDeadline').value = task.deadline || '';
        $('fTags').value = (task.tags || []).join(', ');
        $('fImp').value = task.importance;
        $('fEff').value = task.effort;
        $('rvImp').textContent = task.importance;
        $('rvEff').textContent = task.effort;
    } else {
        const rvImp = $('rvImp'); if (rvImp) rvImp.textContent = 3;
        const rvEff = $('rvEff'); if (rvEff) rvEff.textContent = 3;
    }

    updatePrioPreview();
    const overlay = $('modalOverlay');
    if (overlay) overlay.classList.add('open');
    setTimeout(() => { const t = $('fTitle'); if (t) t.focus(); }, 180);
}

export function closeModal() {
    const overlay = $('modalOverlay');
    if (overlay) overlay.classList.remove('open');
}

async function updatePrioPreview() {
    const imp = +$('fImp').value;
    const eff = +$('fEff').value;
    const dl = $('fDeadline').value;

    const p = await calcPriority(imp, eff, dl);

    const prev = $('prevLabel');
    if (prev) {
        prev.textContent = P_LABEL[p] || p;
        prev.style.color = P_COLOR[p] || 'inherit';
    }
}

export function initModal(refreshCb) {
    _refreshCb = refreshCb;

    const btnOpen = $('openModal'); if (btnOpen) btnOpen.addEventListener('click', () => openModal());
    const mobAdd = $('mobAdd'); if (mobAdd) mobAdd.addEventListener('click', () => openModal());
    const btnClose = $('closeModal'); if (btnClose) btnClose.addEventListener('click', closeModal);
    const btnCancel = $('cancelModal'); if (btnCancel) btnCancel.addEventListener('click', closeModal);

    const overlay = $('modalOverlay');
    if (overlay) {
        overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
    }

    const fImp = $('fImp');
    if (fImp) fImp.addEventListener('input', () => { $('rvImp').textContent = fImp.value; updatePrioPreview(); });

    const fEff = $('fEff');
    if (fEff) fEff.addEventListener('input', () => { $('rvEff').textContent = fEff.value; updatePrioPreview(); });

    const fDl = $('fDeadline');
    if (fDl) fDl.addEventListener('change', updatePrioPreview);

    const form = $('taskForm');
    if (form) {
        form.addEventListener('submit', async e => {
            e.preventDefault();
            const title = $('fTitle').value.trim();
            if (!title) { toast('⚠️ Please enter a task title'); return; }

            const payload = {
                title,
                description: $('fDesc').value.trim(),
                deadline: $('fDeadline').value,
                tags: $('fTags').value.split(',').map(t => t.trim()).filter(Boolean),
                importance: +$('fImp').value,
                effort: +$('fEff').value,
            };

            const id = $('editId').value;
            if (id) {
                await updateTask(id, payload);
                toast('✏️ Task updated');
            } else {
                await createTask(payload);
                toast('✅ Task created!');
            }

            closeModal();
            if (_refreshCb) await _refreshCb();
        });
    }
}
