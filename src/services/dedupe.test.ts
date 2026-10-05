import { describe, it, expect } from 'vitest';
import { findSuspectedTaskDuplicates } from '../db';

function t(id: string, over: Record<string, unknown> = {}) {
  return { id, title: 'Same task', description: 'Same description', deadline: '', ...over };
}

describe('suspected duplicate report', () => {
  it('includes every matching task without preferring completed or started copies', () => {
    const tasks = [t('fresh'), t('done', { done: true }), t('started', { pomodoros_spent: 3 })];
    const before = JSON.stringify(tasks);
    expect(findSuspectedTaskDuplicates(tasks)).toEqual([
      { title: 'Same task', taskIds: ['fresh', 'done', 'started'] },
    ]);
    expect(JSON.stringify(tasks)).toBe(before);
  });

  it('excludes Trash, including legacy camelCase deletion fields', () => {
    expect(findSuspectedTaskDuplicates([
      t('live'), t('trash', { deleted_at: '2026-02-02' }), t('legacy-trash', { deletedAt: '2026-02-02' }),
    ])).toEqual([]);
  });

  it('separates projects, parents, milestones, recurrence, and distinct content', () => {
    expect(findSuspectedTaskDuplicates([
      t('base'), t('project', { project_id: 'p' }), t('parent', { parent_id: 'p' }),
      t('mile', { milestone_id: 'm' }), t('repeat', { recurrence: 'daily' }),
      t('title', { title: 'Other' }), t('description', { description: 'Other' }),
      t('deadline', { deadline: '2026-12-01' }),
    ])).toEqual([]);
  });

  it('normalizes legacy fields without delimiter collisions', () => {
    expect(findSuspectedTaskDuplicates([
      t('snake', { project_id: 'p' }), t('camel', { projectId: 'p' }),
      t('delimiter-a', { title: 'a\u0000b', description: 'c' }),
      t('delimiter-b', { title: 'a', description: 'b\u0000c' }),
    ])).toEqual([{ title: 'Same task', taskIds: ['snake', 'camel'] }]);
  });
});
