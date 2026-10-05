import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

const sql = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn() }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn(async () => sql) } }));

const rows = [
  { id: 'first', title: 'Intentional repeat', description: 'Same content', done: false },
  { id: 'second', title: 'Intentional repeat', description: 'Same content', done: true },
  { id: 'trash', title: 'Intentional repeat', description: 'Same content', deleted_at: '2026-01-01' },
];

describe('startup preserves matching tasks', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', new MemStorage());
    vi.stubGlobal('window', undefined);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('preserves browser rows byte-for-byte through concurrent initialization and repeated scans', async () => {
    localStorage.setItem('cn_tasks_v2', JSON.stringify(rows));
    localStorage.setItem('cn_oplog_v1', '[{"existing":"operation"}]');
    const before = localStorage.getItem('cn_tasks_v2');
    const write = vi.spyOn(localStorage, 'setItem');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { initDb, getSuspectedTaskDuplicates, getAllTasks } = await import('../db');
    await Promise.all([initDb(), initDb()]);
    for (let i = 0; i < 2; i++) {
      expect(await getSuspectedTaskDuplicates()).toEqual([
        { title: 'Intentional repeat', taskIds: ['first', 'second'] },
      ]);
    }
    expect(localStorage.getItem('cn_tasks_v2')).toBe(before);
    expect(localStorage.getItem('cn_oplog_v1')).toBe('[{"existing":"operation"}]');
    expect(await getAllTasks('trash')).toHaveLength(1);
    expect(write).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('All tasks preserved'));
  });

  it('performs no SQL mutations when an existing desktop database boots', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    sql.select.mockImplementation(async (query: string) => {
      if (query.includes('app_state')) return [{ value: '1' }];
      if (query.includes('FROM tasks')) return rows.filter(t => !t.deleted_at);
      throw new Error(`Unexpected query: ${query}`);
    });
    const { initDb, getSuspectedTaskDuplicates } = await import('../db');
    await initDb();
    expect(await getSuspectedTaskDuplicates()).toHaveLength(1);
    expect(sql.execute).not.toHaveBeenCalled();
  });

  it('keeps startup available if the read-only desktop scan fails', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    sql.select.mockImplementation(async (query: string) => {
      if (query.includes('app_state')) return [{ value: '1' }];
      throw new Error('scan unavailable');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { initDb } = await import('../db');
    await expect(initDb()).resolves.toBeUndefined();
    expect(sql.execute).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('all tasks preserved'), expect.any(Error));
  });
});
