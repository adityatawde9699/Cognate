import { describe, it, expect } from 'vitest';
import {
  planLocally,
  detectDisruption,
  nowMinutes,
  DEFAULT_WORK_START,
  DEFAULT_WORK_END,
  type PlanRequest,
  type PlanTask,
  type BusyBlock,
} from './planService';
import type { Task, CalendarEvent } from '../store';

function task(id: string, dur: number, deadline: string, prio: PlanTask['priority'], energy: PlanTask['energy']): PlanTask {
  return { id, title: id, duration_min: dur, energy, deadline, priority: prio, importance: 3, pinned: false, pinned_start_min: null };
}
function req(tasks: PlanTask[], busy: BusyBlock[] = []): PlanRequest {
  return { date: '2026-06-24', work_start_min: DEFAULT_WORK_START, work_end_min: DEFAULT_WORK_END, tasks, busy };
}
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

describe('planLocally (TS mirror of the Rust scheduler)', () => {
  it('keeps every block inside working hours', () => {
    const out = planLocally(req([task('a', 60, '', 'high', 'med'), task('b', 120, '', 'low', 'med')]));
    for (const b of out.blocks) expect(b.start_min >= DEFAULT_WORK_START && b.end_min <= DEFAULT_WORK_END).toBe(true);
  });

  it('produces no overlaps with other blocks or busy time', () => {
    const busy: BusyBlock[] = [{ start_min: 600, end_min: 660, title: 'Standup' }];
    const out = planLocally(req([task('a', 90, '', 'high', 'med'), task('b', 90, '', 'medium', 'med'), task('c', 60, '', 'low', 'med')], busy));
    const intervals: Array<[number, number]> = out.blocks.map((b) => [b.start_min, b.end_min]);
    busy.forEach((b) => intervals.push([b.start_min, b.end_min]));
    for (let i = 0; i < intervals.length; i++)
      for (let j = i + 1; j < intervals.length; j++)
        expect(overlaps(intervals[i], intervals[j])).toBe(false);
  });

  it('schedules earlier deadlines first', () => {
    const out = planLocally(req([task('later', 60, '2026-06-30', 'high', 'med'), task('sooner', 60, '2026-06-25', 'low', 'med')]));
    const sooner = out.blocks.find((b) => b.task_id === 'sooner')!;
    const later = out.blocks.find((b) => b.task_id === 'later')!;
    expect(sooner.start_min).toBeLessThan(later.start_min);
  });

  it('routes around busy calendar blocks and explains it', () => {
    const out = planLocally(req([task('a', 60, '', 'high', 'med')], [{ start_min: DEFAULT_WORK_START, end_min: DEFAULT_WORK_START + 60, title: 'Call' }]));
    const a = out.blocks.find((b) => b.task_id === 'a')!;
    expect(a.start_min).toBeGreaterThanOrEqual(DEFAULT_WORK_START + 60);
    expect(a.reason).toContain('right after');
  });

  it('keeps pinned tasks fixed and routes others around them', () => {
    const pinned: PlanTask = { ...task('pinned', 60, '', 'low', 'med'), pinned: true, pinned_start_min: DEFAULT_WORK_START + 420 };
    const out = planLocally(req([pinned, task('a', 60, '', 'high', 'med')]));
    const p = out.blocks.find((b) => b.task_id === 'pinned')!;
    expect([p.start_min, p.end_min]).toEqual([DEFAULT_WORK_START + 420, DEFAULT_WORK_START + 480]);
    const a = out.blocks.find((b) => b.task_id === 'a')!;
    expect(overlaps([a.start_min, a.end_min], [DEFAULT_WORK_START + 420, DEFAULT_WORK_START + 480])).toBe(false);
  });

  it('reports overflow as unscheduled', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => task(`t${i}`, 60, '', 'medium', 'med'));
    const out = planLocally(req(tasks));
    const capacity = ((DEFAULT_WORK_END - DEFAULT_WORK_START) / 60) as number;
    expect(out.blocks.length).toBe(Math.min(tasks.length, capacity));
    expect(out.unscheduled.length).toBe(Math.max(0, tasks.length - capacity));
  });

  it('honours a learned energy curve over the default circadian one (Act 4)', () => {
    // Learned curve: afternoon (13–16h) is the peak; mornings are low.
    const curve = new Array(24).fill(1);
    for (let h = 13; h <= 16; h++) curve[h] = 2;
    for (let h = 9; h <= 11; h++) curve[h] = 0;
    // A midday block splits the day into a morning and an afternoon window so the
    // energy curve gets to choose between them.
    const busy: BusyBlock[] = [{ start_min: 660, end_min: 780, title: 'Block' }];
    const hi = task('hi', 60, '', 'medium', 'hi'); // high-energy work

    const learned = planLocally({ ...req([hi], busy), energy_curve: curve });
    expect(learned.blocks[0].start_min).toBeGreaterThanOrEqual(DEFAULT_WORK_START + 420); // chose the learned afternoon peak

    const fixed = planLocally(req([hi], busy));
    expect(fixed.blocks[0].start_min).toBe(DEFAULT_WORK_START); // default circadian → morning peak
  });
});

// ── Auto-reflow disruption detection ──
const DATE = '2026-06-24';
function scheduled(id: string, startMin: number, endMin: number, done = false): Task {
  const iso = (m: number) => `${DATE}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
  return { id, title: id, done, scheduled_start: iso(startMin), scheduled_end: iso(endMin) } as unknown as Task;
}
function event(title: string, startMin: number, endMin: number): CalendarEvent {
  const iso = (m: number) => `${DATE}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
  return { id: title, title, start: iso(startMin), end: iso(endMin), source: 'ics', created_at: '' };
}

describe('detectDisruption (auto-reflow trigger)', () => {
  it('returns null when the plan still holds', () => {
    const tasks = [scheduled('a', 600, 660)];
    expect(detectDisruption(tasks, [], DATE, DEFAULT_WORK_START)).toBeNull();
  });

  it('flags a calendar event that lands on planned work', () => {
    const tasks = [scheduled('a', 600, 660)];
    const events = [event('Surprise sync', 615, 645)];
    const d = detectDisruption(tasks, events, DATE, DEFAULT_WORK_START);
    expect(d?.reason).toContain('Surprise sync');
  });

  it('flags a block that has fully elapsed (a slip)', () => {
    const tasks = [scheduled('a', DEFAULT_WORK_START, DEFAULT_WORK_START + 60)];
    const d = detectDisruption(tasks, events_none(), DATE, DEFAULT_WORK_START + 120); // now two hours later
    expect(d?.reason).toContain('running over');
  });

  it('ignores completed blocks that have elapsed', () => {
    const tasks = [scheduled('a', DEFAULT_WORK_START, DEFAULT_WORK_START + 60, true)];
    expect(detectDisruption(tasks, [], DATE, DEFAULT_WORK_START + 120)).toBeNull();
  });

  it('only considers today', () => {
    const other = { ...scheduled('a', DEFAULT_WORK_START, DEFAULT_WORK_START + 60), scheduled_start: '2026-06-23T09:00:00', scheduled_end: '2026-06-23T10:00:00' } as Task;
    expect(detectDisruption([other], [], DATE, 660)).toBeNull();
  });
});

function events_none(): CalendarEvent[] { return []; }

describe('nowMinutes', () => {
  it('converts a clock time to minutes-since-midnight', () => {
    expect(nowMinutes(new Date('2026-06-24T13:30:00'))).toBe(810);
  });
});
