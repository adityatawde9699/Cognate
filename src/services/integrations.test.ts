import { describe, it, expect } from 'vitest';
import { tasksToIcs, parseIcs } from './icalService';
import { parseImport } from './importService';
import { Task } from '../store';

function task(over: Partial<Task>): Task {
  return {
    id: 'x', title: 'T', description: '', tags: [], deadline: '', importance: 3, effort: 3,
    done: false, created_at: '', completed_at: null, pomodoros_spent: 0, priority: 'medium', sort_order: 0,
    project_id: null, parent_id: null, recurrence: 'none', milestone_id: null, custom_fields: {},
    ...over,
  } as Task;
}

describe('iCalendar', () => {
  it('exports a VEVENT for a deadlined task and round-trips', () => {
    const ics = tasksToIcs([task({ id: 'a', title: 'Ship release', deadline: '2026-06-24' }), task({ id: 'b', title: 'No date' })]);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('SUMMARY:Ship release');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260624');
    expect(ics).not.toContain('No date'); // tasks without a deadline are skipped

    const drafts = parseIcs(ics);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ title: 'Ship release', deadline: '2026-06-24' });
  });

  it('escapes special characters', () => {
    const ics = tasksToIcs([task({ title: 'A, B; C', deadline: '2026-01-02' })]);
    expect(ics).toContain('SUMMARY:A\\, B\\; C');
    expect(parseIcs(ics)[0].title).toBe('A, B; C');
  });
});

describe('parseImport', () => {
  it('imports a generic JSON array', () => {
    const d = parseImport('x.json', JSON.stringify([{ title: 'Task 1', priority: 'high', deadline: '2026-06-24' }]));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ title: 'Task 1', importance: 5, deadline: '2026-06-24' });
  });

  it('imports a Todoist-style items array', () => {
    const d = parseImport('todoist.json', JSON.stringify({ items: [{ content: 'Buy milk', due: { date: '2026-07-01' } }] }));
    expect(d[0]).toMatchObject({ title: 'Buy milk', deadline: '2026-07-01' });
  });

  it('imports Trello cards and skips closed ones', () => {
    const d = parseImport('trello.json', JSON.stringify({ cards: [{ name: 'Open card', due: '2026-08-01T00:00:00Z' }, { name: 'Archived', closed: true }] }));
    expect(d).toHaveLength(1);
    expect(d[0].title).toBe('Open card');
  });

  it('imports CSV with a header row', () => {
    const csv = 'title,deadline,priority,tags\n"Write, docs",2026-06-24,high,"work, docs"';
    const d = parseImport('x.csv', csv);
    expect(d[0]).toMatchObject({ title: 'Write, docs', deadline: '2026-06-24', importance: 5 });
    expect(d[0].tags).toEqual(['work', 'docs']);
  });
});
