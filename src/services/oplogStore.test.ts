import { describe, it, expect, beforeEach } from 'vitest';
import { logTaskUpsert, logTaskDelete, projectEntities, _resetForTests } from './oplogStore';
import type { Task } from '../store';

// Minimal in-memory localStorage so db.js's browser fallback works under node.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, description: '', deadline: '', tags: [],
    importance: 3, effort: 3, priority: 'medium', done: false, sort_order: 0,
    ...over,
  } as Task;
}

describe('oplogStore (shadow recording → projection)', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemStorage();
    _resetForTests();
  });

  it('records a created task so the projection reflects it', async () => {
    await logTaskUpsert(task('t1', { title: 'Write the spec' }));
    const projected = await projectEntities();
    expect(projected.get('t1')?.title).toBe('Write the spec');
    expect(projected.get('t1')?.done).toBe(false);
  });

  it('a later edit wins over the earlier value', async () => {
    await logTaskUpsert(task('t1', { title: 'Draft' }));
    await logTaskUpsert(task('t1', { title: 'Final', done: true }));
    const projected = await projectEntities();
    expect(projected.get('t1')?.title).toBe('Final');
    expect(projected.get('t1')?.done).toBe(true);
  });

  it('a delete tombstones the task out of the projection', async () => {
    await logTaskUpsert(task('t1'));
    await logTaskDelete('t1');
    const projected = await projectEntities();
    expect(projected.has('t1')).toBe(false);
  });

  it('preserves array/object fields (tags, custom_fields) through the log', async () => {
    await logTaskUpsert(task('t1', { tags: ['work', 'urgent'], custom_fields: { ticket: 'ENG-42' } }));
    const projected = await projectEntities();
    expect(projected.get('t1')?.tags).toEqual(['work', 'urgent']);
    expect(projected.get('t1')?.custom_fields).toEqual({ ticket: 'ENG-42' });
  });
});
