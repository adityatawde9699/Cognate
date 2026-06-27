import { describe, it, expect } from 'vitest';
import { entityStateToTask, projectTasks, diffTasks } from './projector';
import { Clock, entityToOps, setOp } from './oplog';
import type { Task } from '../store';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, description: '', deadline: '', tags: [], importance: 3, effort: 3,
    done: false, created_at: '', completed_at: null, pomodoros_spent: 0, priority: 'medium',
    sort_order: 0, project_id: null, parent_id: null, recurrence: 'none', milestone_id: null,
    custom_fields: {}, deleted_at: null, duration_min: 0, scheduled_start: null, scheduled_end: null,
    energy: 'med', pinned: false, ...over,
  };
}

describe('entityStateToTask', () => {
  it('fills sane defaults for fields the op-log never set', () => {
    const t = entityStateToTask('t1', { title: 'Lonely title' });
    expect(t.id).toBe('t1');
    expect(t.title).toBe('Lonely title');
    expect(t.done).toBe(false);
    expect(t.tags).toEqual([]);
    expect(t.energy).toBe('med');
    expect(t.priority).toBe('medium');
    expect(t.deleted_at).toBeNull();
  });
});

describe('projectTasks', () => {
  it('rebuilds tasks from an op-log, newest write per field', () => {
    const c = new Clock('A', 0);
    const ops = [
      ...entityToOps(c, 't1', { title: 'Spec', done: false, priority: 'high' }, 10),
      setOp(c, 't1', 'done', true, 50),
    ];
    const tasks = projectTasks(ops);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 't1', title: 'Spec', done: true, priority: 'high' });
  });
});

describe('diffTasks', () => {
  it('flags new and changed tasks as upserts, vanished ones as deletes', () => {
    const a = task('a', { title: 'A' });
    const b = task('b', { title: 'B' });
    const current = [a, b];

    const bChanged = task('b', { title: 'B edited' });
    const c = task('c', { title: 'C new' });
    const projected = [a, bChanged, c]; // a unchanged, b changed, c new, (b stays), nothing removed yet

    const diff = diffTasks(current, projected);
    expect(diff.upserts.map((t) => t.id).sort()).toEqual(['b', 'c']);
    expect(diff.deletes).toEqual([]);
  });

  it('reports a task present locally but gone from the projection as a delete', () => {
    const current = [task('a'), task('b')];
    const projected = [task('a')]; // b was tombstoned remotely
    const diff = diffTasks(current, projected);
    expect(diff.upserts).toEqual([]);
    expect(diff.deletes).toEqual(['b']);
  });

  it('is a no-op when projection already equals current state', () => {
    const current = [task('a', { title: 'same', tags: ['x'] }), task('b')];
    const projected = [task('a', { title: 'same', tags: ['x'] }), task('b')];
    const diff = diffTasks(current, projected);
    expect(diff.upserts).toEqual([]);
    expect(diff.deletes).toEqual([]);
  });
});
