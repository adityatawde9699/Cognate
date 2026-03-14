/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/ui/export.js — Data Export (S6)
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
import { getAllTasks } from '../db.js';
import { toast } from '../utils/toast.js';

function downloadStr(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

export async function exportJSON() {
    try {
        const tasks = await getAllTasks('all');
        const json = JSON.stringify(tasks, null, 2);
        downloadStr(json, 'cognote-export.json', 'application/json');
        toast('⬇ JSON Exported');
    } catch (err) {
        toast('⚠️ Export failed');
        console.error(err);
    }
}

export async function exportCSV() {
    try {
        const tasks = await getAllTasks('all');
        if (!tasks.length) return toast('⚠️ No tasks to export');

        const headers = ['id', 'title', 'deadline', 'priority', 'done', 'pomodoros_spent', 'tags'];
        const csv = [
            headers.join(','),
            ...tasks.map(t => [
                t.id,
                `"${(t.title || '').replace(/"/g, '""')}"`,
                t.deadline || '',
                t.priority,
                t.done ? 1 : 0,
                t.pomodorosSpent || 0,
                `"${(t.tags || []).join(', ')}"`
            ].join(','))
        ].join('\n');

        downloadStr(csv, 'cognote-export.csv', 'text/csv');
        toast('⬇ CSV Exported');
    } catch (err) {
        toast('⚠️ Export failed');
        console.error(err);
    }
}
