import { describe, it, expect, beforeEach } from 'vitest';
import { exportBundle } from './syncService';
import { logTaskUpsert, logTaskDelete, ingestOps, _resetForTests } from './oplogStore';
import { projectTasks } from './projector';
import { loadOps } from '../db';
import type { Op } from './oplog';
import type { Task } from '../store';

// In-memory localStorage so db.js's browser fallback works under node.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, description: '', deadline: '', tags: [], importance: 3, effort: 3,
    done: false, created_at: '2026-01-01', completed_at: null, pomodoros_spent: 0, priority: 'medium',
    sort_order: 0, project_id: null, parent_id: null, recurrence: 'none', milestone_id: null,
    custom_fields: {}, deleted_at: null, energy: 'med', pinned: false, ...over,
  };
}

/** Switch the active "device" by swapping its storage and reloading the clock. */
async function on<T>(store: MemStorage, fn: () => Promise<T>): Promise<T> {
  (globalThis as any).localStorage = store;
  _resetForTests();
  return fn();
}

function projectedById(ops: Op[]): Record<string, Task> {
  return Object.fromEntries(projectTasks(ops).map((t) => [t.id, t]));
}

describe('syncService — two devices converge through a bundle', () => {
  let A: MemStorage;
  let B: MemStorage;
  beforeEach(() => { A = new MemStorage(); B = new MemStorage(); });

  it('exports a structurally-valid bundle', async () => {
    const json = await on(A, async () => {
      await logTaskUpsert(task('t1'));
      return exportBundle();
    });
    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe('cognate-oplog-bundle');
    expect(Array.isArray(parsed.ops)).toBe(true);
    expect(parsed.ops.length).toBeGreaterThan(0);
  });

  it('merges both devices to identical state regardless of import direction', async () => {
    // Device A creates t1 and t2.
    const aBundle = await on(A, async () => {
      await logTaskUpsert(task('t1', { title: 'A: spec' }));
      await logTaskUpsert(task('t2', { title: 'A: review' }));
      return exportBundle();
    });

    // Device B (concurrently) edits t1 and adds t3.
    const bBundle = await on(B, async () => {
      await logTaskUpsert(task('t1', { title: 'B: spec edited' }));
      await logTaskUpsert(task('t3', { title: 'B: deploy' }));
      return exportBundle();
    });

    // A imports B's bundle…
    const aFinal = await on(A, async () => {
      await ingestOps(JSON.parse(bBundle).ops as Op[]);
      return loadOps();
    });
    // …and B imports A's bundle.
    const bFinal = await on(B, async () => {
      await ingestOps(JSON.parse(aBundle).ops as Op[]);
      return loadOps();
    });

    const pa = projectedById(aFinal);
    const pb = projectedById(bFinal);

    // Same set of tasks on both devices.
    expect(Object.keys(pa).sort()).toEqual(['t1', 't2', 't3']);
    expect(Object.keys(pb).sort()).toEqual(['t1', 't2', 't3']);
    // And identical field-for-field (the conflicting t1 resolves the same way).
    for (const id of ['t1', 't2', 't3']) {
      expect(pa[id].title).toBe(pb[id].title);
      expect(pa[id].done).toBe(pb[id].done);
    }
  });

  it('a delete on one device propagates to the other', async () => {
    const aBundle = await on(A, async () => {
      await logTaskUpsert(task('t1'));
      await logTaskUpsert(task('t2'));
      return exportBundle();
    });
    // B receives A's tasks, then purges t2.
    const bBundle = await on(B, async () => {
      await ingestOps(JSON.parse(aBundle).ops as Op[]);
      await logTaskDelete('t2');
      return exportBundle();
    });
    // A receives B's bundle (including the tombstone).
    const aFinal = await on(A, async () => {
      await ingestOps(JSON.parse(bBundle).ops as Op[]);
      return loadOps();
    });
    expect(Object.keys(projectedById(aFinal))).toEqual(['t1']);
  });
});
