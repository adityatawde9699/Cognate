import { describe, it, expect } from 'vitest';
import { parseQuickAdd, quickAddPreview, mergeQuickAdd } from './nlQuickAdd';

// A fixed "now" so relative dates are deterministic: Thu 2026-06-25 10:00 local.
const NOW = new Date(2026, 5, 25, 10, 0, 0);
const p = (s: string) => parseQuickAdd(s, NOW);

describe('nlQuickAdd — the headline example', () => {
  it('parses "call Sam tmrw 5pm 30m #work !!"', () => {
    const r = p('call Sam tmrw 5pm 30m #work !!');
    expect(r.title).toBe('call Sam');
    expect(r.deadline).toBe('2026-06-26'); // tomorrow
    expect(r.startMin).toBe(17 * 60);      // 5pm
    expect(r.durationMin).toBe(30);
    expect(r.tags).toEqual(['work']);
    expect(r.importance).toBe(4);
    expect(r.priorityLabel).toBe('high');
  });
});

describe('nlQuickAdd — tags & priority', () => {
  it('collects multiple tags and strips them from the title', () => {
    const r = p('email #client #urgent the brief');
    expect(r.tags).toEqual(['client', 'urgent']);
    expect(r.title).toBe('email the brief');
  });
  it('maps ! / !! / !!! and p1–p3', () => {
    expect(p('x !!!').importance).toBe(5);
    expect(p('x p1').importance).toBe(5);
    expect(p('x !!').importance).toBe(4);
    expect(p('x !').importance).toBe(3);
    expect(p('x p3').priorityLabel).toBe('medium');
  });
  it('does not treat an attached "!" inside a word as priority', () => {
    const r = p('call mom!');
    expect(r.title).toBe('call mom!');
    expect(r.priorityLabel).toBeNull();
  });
});

describe('nlQuickAdd — times', () => {
  it('parses 12h, 24h, noon and midnight', () => {
    expect(p('ship at 5pm').startMin).toBe(17 * 60);
    expect(p('ship 5:30pm').startMin).toBe(17 * 60 + 30);
    expect(p('standup 09:15').startMin).toBe(9 * 60 + 15);
    expect(p('lunch noon').startMin).toBe(12 * 60);
    expect(p('deploy midnight').startMin).toBe(0);
  });
  it('keeps the title clean of the time token', () => {
    expect(p('write report at 3pm').title).toBe('write report');
  });
});

describe('nlQuickAdd — durations (not confused with times)', () => {
  it('parses h/m combos', () => {
    expect(p('deep work 2h').durationMin).toBe(120);
    expect(p('review 1h30m').durationMin).toBe(90);
    expect(p('call 45m').durationMin).toBe(45);
    expect(p('focus 90min').durationMin).toBe(90);
  });
  it('does not read the "m" in "5pm" as minutes', () => {
    const r = p('demo 5pm');
    expect(r.startMin).toBe(17 * 60);
    expect(r.durationMin).toBeNull();
  });
});

describe('nlQuickAdd — dates', () => {
  it('today / tomorrow / tonight', () => {
    expect(p('a today').deadline).toBe('2026-06-25');
    expect(p('a tomorrow').deadline).toBe('2026-06-26');
    expect(p('a tonight').deadline).toBe('2026-06-25');
  });
  it('relative "in N days/weeks"', () => {
    expect(p('a in 3 days').deadline).toBe('2026-06-28');
    expect(p('a in 2 weeks').deadline).toBe('2026-07-09');
  });
  it('bare weekday = next occurrence; "next" adds a week', () => {
    // NOW is Thursday 06-25; next Monday is 06-29.
    expect(p('a monday').deadline).toBe('2026-06-29');
    expect(p('a next monday').deadline).toBe('2026-07-06');
  });
  it('explicit ISO and m/d', () => {
    expect(p('a 2026-07-04').deadline).toBe('2026-07-04');
    expect(p('a 7/4').deadline).toBe('2026-07-04');
  });
  it('month names', () => {
    expect(p('a jul 4').deadline).toBe('2026-07-04');
    expect(p('a December 1st').deadline).toBe('2026-12-01');
  });
});

describe('nlQuickAdd — robustness', () => {
  it('a bare title yields just a title', () => {
    const r = p('buy milk');
    expect(r).toMatchObject({ title: 'buy milk', deadline: '', startMin: null, durationMin: null, tags: [] });
    expect(r.importance).toBe(3);
  });
  it('strips dangling connectors left by token removal', () => {
    expect(p('finish deck by friday').title).toBe('finish deck');
  });
  it('preview summarizes the structured fields', () => {
    expect(quickAddPreview(p('call Sam tmrw 5pm 30m #work !!')))
      .toBe('2026-06-26 · 5:00 PM · 30m · high · #work');
  });
});

describe('nlQuickAdd — mergeQuickAdd (AI fills gaps only)', () => {
  it('AI fills fields the parser missed', () => {
    const base = parseQuickAdd('lunch with Dana', NOW); // no date/time/duration
    const merged = mergeQuickAdd(base, { deadline: '2026-06-30', startMin: 720, durationMin: 60, importance: 4, tags: ['social'] });
    expect(merged.title).toBe('lunch with Dana');
    expect(merged.deadline).toBe('2026-06-30');
    expect(merged.startMin).toBe(720);
    expect(merged.durationMin).toBe(60);
    expect(merged.tags).toEqual(['social']);
    expect(merged.importance).toBe(4);
    expect(merged.priorityLabel).toBe('high');
  });

  it('the deterministic parse wins where it found something', () => {
    const base = parseQuickAdd('ship report tomorrow 30m !!', NOW); // deadline+dur+priority set
    const merged = mergeQuickAdd(base, { deadline: '2099-01-01', durationMin: 999, importance: 1, title: 'WRONG' });
    expect(merged.title).toBe('ship report');     // base title kept
    expect(merged.deadline).toBe('2026-06-26');    // base deadline kept
    expect(merged.durationMin).toBe(30);           // base duration kept
    expect(merged.importance).toBe(4);             // base priority (!!) kept, not AI's 1
  });

  it('unions tags from both', () => {
    const base = parseQuickAdd('email #work', NOW);
    expect(mergeQuickAdd(base, { tags: ['urgent', 'work'] }).tags.sort()).toEqual(['urgent', 'work']);
  });
});
