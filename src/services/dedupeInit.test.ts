import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, dedupeTasks, getAllTasks } from '../db';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// Simulate the historical double-seed: every demo task stored twice.
function plantDuplicates() {
  const base = [
    { title: '📝 Design landing page', description: 'd1', deadline: '', tags: [] },
    { title: 'Ship v2', description: 'd2', deadline: '2026-07-01', tags: [] },
  ];
  const rows: any[] = [];
  let i = 0;
  for (const run of [0, 1]) {
    for (const b of base) {
      rows.push({
        id: `id-${run}-${i++}`, ...b, importance: 3, effort: 3, done: false,
        createdAt: `2026-01-0${run + 1}`, created_at: `2026-01-0${run + 1}`,
        completedAt: null, pomodorosSpent: 0, sortOrder: i, sort_order: i,
      });
    }
  }
  localStorage.setItem('cn_tasks_v2', JSON.stringify(rows));
}

describe('initDb heals pre-existing duplicate seed data', () => {
  beforeEach(() => { (globalThis as any).localStorage = new MemStorage(); });

  it('dedupeTasks removes the doubled rows directly', async () => {
    plantDuplicates();
    const removed = await dedupeTasks();
    expect(removed).toBe(2); // 4 rows → 2 unique
    const live = await getAllTasks('all');
    expect(live.length).toBe(2);
  });

  it('initDb runs the one-time cleanup on launch', async () => {
    plantDuplicates();
    await initDb();
    const live = await getAllTasks('all');
    expect(live.length).toBe(2);
  });
});
