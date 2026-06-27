import { describe, it, expect } from 'vitest';
import { parseJSON } from './aiService';
import { applyAiQuery } from '../hooks/useVisibleTasks';
import { Task } from '../store';

describe('parseJSON', () => {
  it('parses a bare JSON array', () => {
    expect(parseJSON<number[]>('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    const raw = '```json\n{"a": 1}\n```';
    expect(parseJSON<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('slices JSON out of surrounding prose', () => {
    const raw = 'Sure! Here you go: [{"id":"x"}] hope that helps';
    expect(parseJSON<any[]>(raw)).toEqual([{ id: 'x' }]);
  });

  it('throws a clear error (echoing the reply) when there is no JSON', () => {
    // A provider/model that returns plain text — e.g. "User error" with HTTP 200.
    expect(() => parseJSON('User error')).toThrow(/didn't return JSON.*User error/);
  });

  it('throws a clear error when the JSON is malformed', () => {
    expect(() => parseJSON('{"a": 1,,,}')).toThrow(/malformed JSON/);
  });
});

describe('applyAiQuery', () => {
  const today = '2026-06-24';
  const t = (over: Partial<Task>): Task => ({
    id: 'i', title: 'T', description: '', tags: [], deadline: '', importance: 3, effort: 3,
    done: false, created_at: '', completed_at: null, pomodoros_spent: 0, priority: 'medium', sort_order: 0,
    project_id: null, parent_id: null, recurrence: 'none', milestone_id: null, custom_fields: {},
    ...over,
  });

  it('filters by done + priority', () => {
    const tasks = [t({ id: 'a', done: true }), t({ id: 'b', priority: 'high' })];
    expect(applyAiQuery(tasks, { done: false, priority: 'high' }, today).map((x) => x.id)).toEqual(['b']);
  });

  it('filters overdue', () => {
    const tasks = [t({ id: 'a', deadline: '2026-06-01' }), t({ id: 'b', deadline: '2026-12-01' })];
    expect(applyAiQuery(tasks, { overdue: true }, today).map((x) => x.id)).toEqual(['a']);
  });

  it('filters dueWithinDays', () => {
    const tasks = [t({ id: 'a', deadline: '2026-06-26' }), t({ id: 'b', deadline: '2026-07-30' })];
    expect(applyAiQuery(tasks, { dueWithinDays: 7 }, today).map((x) => x.id)).toEqual(['a']);
  });

  it('filters untouched (not started, not done)', () => {
    const tasks = [t({ id: 'a', pomodoros_spent: 0 }), t({ id: 'b', pomodoros_spent: 2 }), t({ id: 'c', done: true })];
    expect(applyAiQuery(tasks, { untouched: true }, today).map((x) => x.id)).toEqual(['a']);
  });

  it('filters by tag case-insensitively and minImportance', () => {
    const tasks = [t({ id: 'a', tags: ['Work'], importance: 5 }), t({ id: 'b', tags: ['work'], importance: 2 })];
    expect(applyAiQuery(tasks, { tag: 'work', minImportance: 4 }, today).map((x) => x.id)).toEqual(['a']);
  });
});
