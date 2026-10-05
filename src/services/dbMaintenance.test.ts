import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const sql = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn(), close: vi.fn() }));
vi.mock('@tauri-apps/plugin-sql', () => ({ default: { load: vi.fn(async () => sql) } }));

describe('database restore maintenance', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    sql.select.mockResolvedValue([]); sql.close.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('drains in-flight calls, closes the pool, and freezes new access until reload', async () => {
    let finish!: (rows: unknown[]) => void;
    sql.select.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const db = await import('../db');
    const read = db.getAllTasks('all');
    await vi.waitFor(() => expect(sql.select).toHaveBeenCalled());
    const restore = vi.fn(async () => 'restored');
    const maintenance = db.runDatabaseMaintenance(restore, true);
    await expect(db.getAllTasks('all')).rejects.toThrow('restore in progress');
    expect(sql.close).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
    finish([]); await read;
    expect(await maintenance).toBe('restored');
    expect(sql.close).toHaveBeenCalledWith('sqlite:cognote.db');
    expect(restore).toHaveBeenCalledOnce();
    await expect(db.getAllTasks('all')).rejects.toThrow('restore in progress');
  });

  it('allows reconnection after restore fails', async () => {
    const db = await import('../db');
    await db.getAllTasks('all');
    await expect(db.runDatabaseMaintenance(async () => { throw new Error('bad snapshot'); }, true)).rejects.toThrow('bad snapshot');
    await expect(db.getAllTasks('all')).resolves.toEqual([]);
  });

  it('aborts before restoring when pool close fails', async () => {
    const db = await import('../db');
    await db.getAllTasks('all');
    sql.close.mockRejectedValueOnce(new Error('close failed'));
    const restore = vi.fn();
    await expect(db.runDatabaseMaintenance(restore, true)).rejects.toThrow('close failed');
    expect(restore).not.toHaveBeenCalled();
    await expect(db.getAllTasks('all')).resolves.toEqual([]);
  });
});
