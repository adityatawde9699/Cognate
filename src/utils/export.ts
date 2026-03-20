import { getAllTasks } from '../db';
import { toast } from './toast';

function downloadStr(content: string, filename: string, type: string) {
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
      ...tasks.map((t: any) => [
        t.id,
        `"${(t.title || '').replace(/"/g, '""')}"`,
        t.deadline || '',
        t.priority,
        t.done ? 1 : 0,
        t.pomodoros_spent || 0,
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
