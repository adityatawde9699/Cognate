import { describe, it, expect } from 'vitest';
import { planDedupe } from '../db';

function t(id: string, over: Record<string, any> = {}) {
  return {
    id, title: 'Task', description: '', deadline: '', parent_id: null, recurrence: 'none',
    done: false, pomodoros_spent: 0, scheduled_start: null, deleted_at: null, created_at: '2026-01-01', ...over,
  };
}

describe('planDedupe (heals the historical double-seed)', () => {
  it('removes an exact duplicate, keeping one', () => {
    const remove = planDedupe([t('a'), t('b')]); // same defining fields
    expect(remove.size).toBe(1);
  });

  it('keeps the completed copy and removes the untouched twin', () => {
    const remove = planDedupe([t('twin', { done: false }), t('done', { done: true })]);
    expect(remove.has('twin')).toBe(true);
    expect(remove.has('done')).toBe(false);
  });

  it('prefers the started copy (pomodoros) over an untouched one', () => {
    const remove = planDedupe([t('fresh'), t('started', { pomodoros_spent: 3 })]);
    expect([...remove]).toEqual(['fresh']);
  });

  it('leaves genuinely-distinct tasks alone', () => {
    const remove = planDedupe([t('a', { title: 'Alpha' }), t('b', { title: 'Beta' })]);
    expect(remove.size).toBe(0);
  });

  it('never removes tasks in Trash', () => {
    const remove = planDedupe([t('live'), t('trashed', { deleted_at: '2026-02-02' })]);
    expect(remove.size).toBe(0);
  });

  it('collapses a triple to a single keeper', () => {
    const remove = planDedupe([t('a', { created_at: '2026-01-03' }), t('b', { created_at: '2026-01-01' }), t('c', { created_at: '2026-01-02' })]);
    expect(remove.size).toBe(2);
    expect(remove.has('b')).toBe(false); // earliest created is kept
  });
});
