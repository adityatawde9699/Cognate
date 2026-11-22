import { describe, it, expect, beforeEach } from 'vitest';
import { Clock, materialize, type Op } from './oplog';
import { recordOps, projectRecords, unloggedRecordOps, isRecordEntity } from './recordSync';
import { isTaskEntity, projectTasks } from './projector';
import { exportBundle, importBundle } from './syncService';
import { _resetForTests } from './oplogStore';
import { createMilestone, updateMilestone, deleteMilestone, getMilestones, createTemplate, getTemplates, loadOps } from '../db';

class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
async function on<T>(store: MemStorage, fn: () => Promise<T>): Promise<T> {
  (globalThis as any).localStorage = store;
  _resetForTests();
  return fn();
}

const milestone = (id: string, name: string, sort_order = 0) =>
  ({ id, project_id: null, name, due: '', created_at: '2026-11-22T00:00:00Z', sort_order });

describe('recordSync — milestones and templates in history', () => {
  it('logs only changed fields and a tombstone on removal', () => {
    const clock = new Clock('a', 1000);
    const created = recordOps(clock, 'milestones', [], [milestone('m1', 'Launch')]);
    expect(new Set(created.map(op => op.entity))).toEqual(new Set(['milestone:m1']));
    const renamed = recordOps(clock, 'milestones', [milestone('m1', 'Launch')], [milestone('m1', 'Ship')]);
    expect(renamed.map(op => op.kind === 'set' && op.field)).toEqual(['name']);
    const removed = recordOps(clock, 'milestones', [milestone('m1', 'Ship')], []);
    expect(removed).toHaveLength(1);
    expect(removed[0].kind).toBe('del');
  });

  it('never projects records as tasks', () => {
    const clock = new Clock('a', 1000);
    const ops = [
      ...recordOps(clock, 'milestones', [], [milestone('m1', 'Launch')]),
      ...recordOps(clock, 'templates', [], [{ id: 't1', name: 'Weekly', data: { tasks: [] }, created_at: 'x' }]),
    ];
    expect(isRecordEntity('milestone:m1')).toBe(true);
    expect(isTaskEntity('template:t1')).toBe(false);
    expect(projectTasks(ops)).toEqual([]);
  });

  it('later edits win per field across devices', () => {
    const a = new Clock('a', 1000), b = new Clock('b', 2000);
    const base = recordOps(a, 'milestones', [], [milestone('m1', 'Launch')]);
    for (const op of base) b.receive(op.hlc); // B has seen A's milestone before renaming it
    const rename = recordOps(b, 'milestones', [milestone('m1', 'Launch')], [milestone('m1', 'Ship')]);
    const reorder = recordOps(a, 'milestones', [milestone('m1', 'Launch')], [milestone('m1', 'Launch', 4)]);
    const { milestones } = projectRecords(materialize([...base, ...rename, ...reorder]));
    expect(milestones).toEqual([{ ...milestone('m1', 'Ship'), sort_order: 4 }]);
  });

  it('skips a broken template instead of blocking the sync', () => {
    const clock = new Clock('a', 1000);
    const ops = [
      ...recordOps(clock, 'templates', [], [{ id: 't1', name: 'Bad', data: 'nope', created_at: '' }]),
      ...recordOps(clock, 'templates', [], [{ id: 't2', name: 'Good', data: { tasks: [] }, created_at: '' }]),
    ];
    expect(projectRecords(materialize(ops)).templates.map(t => t.id)).toEqual(['t2']);
  });

  it('backfills records that predate record sync, once', () => {
    const clock = new Clock('a', 1000);
    const local = { milestones: [milestone('m1', 'Old')], templates: [] };
    const fresh = unloggedRecordOps(clock, local, new Map(), []);
    expect(fresh.length).toBeGreaterThan(0);
    expect(unloggedRecordOps(clock, local, materialize(fresh), fresh)).toEqual([]);
  });
});

describe('recordSync — two devices through a bundle', () => {
  let A: MemStorage, B: MemStorage;
  beforeEach(() => { A = new MemStorage(); B = new MemStorage(); });

  it('creates, edits and deletes milestones and templates on the other device', async () => {
    const bundle = await on(A, async () => {
      const m = await createMilestone('Launch', null, '2026-12-01');
      await updateMilestone(m.id, { name: 'Ship', due: '2026-12-02' });
      await createMilestone('Later');
      await createTemplate('Weekly review', { tasks: [] });
      expect((await loadOps()).some((op: Op) => op.entity === `milestone:${m.id}`)).toBe(true);
      return exportBundle();
    });
    await on(B, async () => {
      await importBundle(bundle);
      expect((await getMilestones()).map((m: any) => [m.name, m.due])).toEqual([['Ship', '2026-12-02'], ['Later', '']]);
      expect((await getTemplates()).map((t: any) => t.name)).toEqual(['Weekly review']);
    });
    const back = await on(B, async () => {
      const later = (await getMilestones()).find((m: any) => m.name === 'Later');
      await deleteMilestone(later!.id);
      return exportBundle();
    });
    await on(A, async () => {
      await importBundle(back);
      expect((await getMilestones()).map((m: any) => m.name)).toEqual(['Ship']);
    });
  });
});
