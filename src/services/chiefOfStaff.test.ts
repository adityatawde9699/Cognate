import { describe, it, expect } from 'vitest';
import { morningBrief, detectOvercommit, endOfDayReview, estimateMinutes } from './chiefOfStaff';
import type { Task } from '../store';

const NOW = new Date(2026, 5, 25, 8, 0, 0); // Thu 2026-06-25
const TODAY = '2026-06-25';

function task(over: Partial<Task> = {}): Task {
  return {
    id: Math.random().toString(36).slice(2), title: 'T', description: '', tags: [], deadline: '',
    importance: 3, effort: 3, done: false, created_at: '2026-06-01', completed_at: null,
    pomodoros_spent: 0, priority: 'medium', sort_order: 0, project_id: null, parent_id: null,
    recurrence: 'none', milestone_id: null, custom_fields: {}, deleted_at: null,
    duration_min: 0, scheduled_start: null, scheduled_end: null, energy: 'med', pinned: false, ...over,
  };
}

describe('chiefOfStaff — morning brief', () => {
  it('summarizes the day: blocks, first start, due/overdue', () => {
    const b = morningBrief([
      task({ title: 'A', scheduled_start: `${TODAY}T09:00:00`, scheduled_end: `${TODAY}T10:00:00` }),
      task({ title: 'B', scheduled_start: `${TODAY}T11:00:00`, scheduled_end: `${TODAY}T11:30:00` }),
      task({ title: 'Due', deadline: TODAY }),
      task({ title: 'Late', deadline: '2026-06-20' }),
      task({ title: 'Done', done: true, scheduled_start: `${TODAY}T07:00:00` }), // excluded
    ], NOW);
    expect(b.scheduled.map((s) => s.task.title)).toEqual(['A', 'B']); // sorted by start
    expect(b.firstBlockMin).toBe(9 * 60);
    expect(b.scheduledMinutes).toBe(90);
    expect(b.dueToday.map((t) => t.title)).toEqual(['Due']);
    expect(b.overdue.map((t) => t.title)).toEqual(['Late']);
    expect(b.headline).toContain('2 blocks planned');
    expect(b.headline).toContain('1 overdue');
  });

  it('nudges to plan when the day is empty', () => {
    expect(morningBrief([], NOW).headline).toMatch(/auto-plan/i);
  });
});

describe('chiefOfStaff — overcommitment', () => {
  const work = { start: 9 * 60, end: 12 * 60 }; // 3h capacity

  it('flags an overloaded day and suggests the least-important moves', () => {
    const tasks = [
      task({ title: 'Big', deadline: TODAY, duration_min: 150, importance: 5, priority: 'high' }),
      task({ title: 'Med', deadline: TODAY, duration_min: 90, importance: 3 }),
      task({ title: 'Small', deadline: TODAY, duration_min: 60, importance: 1, priority: 'low' }),
    ]; // 300 min committed vs 180 capacity → 120 over
    const o = detectOvercommit(tasks, work, TODAY);
    expect(o.isOvercommitted).toBe(true);
    expect(o.committedMin).toBe(300);
    expect(o.overBy).toBe(120);
    // Frees ≥120 min starting from the least important (Small 60 + Med 90).
    expect(o.suggestions.map((t) => t.title)).toEqual(['Small', 'Med']);
  });

  it('reports a comfortable day as fine', () => {
    const o = detectOvercommit([task({ deadline: TODAY, duration_min: 60 })], work, TODAY);
    expect(o.isOvercommitted).toBe(false);
    expect(o.suggestions).toEqual([]);
  });
});

describe('chiefOfStaff — end-of-day review', () => {
  it('counts completed, slipped, focus and on-plan', () => {
    const r = endOfDayReview([
      task({ title: 'C1', done: true, completed_at: `${TODAY}T16:00:00`, scheduled_start: `${TODAY}T09:00:00`, pomodoros_spent: 2 }),
      task({ title: 'C2', done: true, completed_at: `${TODAY}T17:00:00`, pomodoros_spent: 1 }),
      task({ title: 'Slip', scheduled_start: `${TODAY}T14:00:00` }),
      task({ title: 'Old', done: true, completed_at: '2026-06-24T10:00:00' }), // not today
    ], NOW);
    expect(r.completed.map((t) => t.title).sort()).toEqual(['C1', 'C2']);
    expect(r.slipped.map((t) => t.title)).toEqual(['Slip']);
    expect(r.focusCount).toBe(3);
    expect(r.onPlanCount).toBe(1); // only C1 was scheduled today
  });
});

describe('chiefOfStaff — estimateMinutes', () => {
  it('prefers a placed block, then duration, then effort', () => {
    expect(estimateMinutes(task({ scheduled_start: `${TODAY}T09:00:00`, scheduled_end: `${TODAY}T10:15:00` }))).toBe(75);
    expect(estimateMinutes(task({ duration_min: 40 }))).toBe(40);
    expect(estimateMinutes(task({ effort: 5 }))).toBe(90);
  });
});
