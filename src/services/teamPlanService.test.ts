import { describe, it, expect } from 'vitest';
import { planTeam, toTeamPlanTask, type TeamMember, type TeamPlanTask } from './teamPlanService';

const member = (actor: string, over: Partial<TeamMember> = {}): TeamMember => ({
  actor, work_start_min: 9 * 60, work_end_min: 17 * 60, busy: [], ...over,
});

const t = (id: string, durMin: number, assignee: string | null = null, over: Partial<TeamPlanTask> = {}): TeamPlanTask => ({
  ...toTeamPlanTask({ id, title: id, duration_min: durMin }, assignee),
  ...over,
});

describe('teamPlanService.planTeam', () => {
  it('honours explicit assignments', () => {
    const res = planTeam({
      date: '2026-06-25',
      members: [member('A'), member('B')],
      tasks: [t('t1', 60, 'A'), t('t2', 60, 'B')],
    });
    expect(res.byMember['A'].blocks.map((b) => b.task_id)).toEqual(['t1']);
    expect(res.byMember['B'].blocks.map((b) => b.task_id)).toEqual(['t2']);
    expect(res.assignments).toHaveLength(0); // nothing to auto-assign
  });

  it('balances unassigned work across members by load', () => {
    const res = planTeam({
      date: '2026-06-25',
      members: [member('A'), member('B')],
      tasks: [t('t1', 120), t('t2', 120), t('t3', 120), t('t4', 120)],
    });
    const a = res.loads.find((l) => l.actor === 'A')!;
    const b = res.loads.find((l) => l.actor === 'B')!;
    expect(a.assigned_min).toBe(240);
    expect(b.assigned_min).toBe(240); // even split, not 4-vs-0
    expect(res.assignments).toHaveLength(4);
  });

  it('routes around an already-loaded member', () => {
    // A starts with a big explicit task; the balancer should favour B.
    const res = planTeam({
      date: '2026-06-25',
      members: [member('A'), member('B')],
      tasks: [t('big', 360, 'A'), t('x', 60), t('y', 60)],
    });
    const aAuto = res.assignments.filter((x) => x.actor === 'A').length;
    const bAuto = res.assignments.filter((x) => x.actor === 'B').length;
    expect(bAuto).toBeGreaterThan(aAuto);
  });

  it('flags overload when assigned work exceeds the capacity budget', () => {
    const res = planTeam({
      date: '2026-06-25',
      members: [member('A', { capacity_min: 120 })],
      tasks: [t('t1', 90, 'A'), t('t2', 90, 'A')], // 180 > 120 capacity budget
    });
    const a = res.loads[0];
    expect(a.assigned_min).toBe(180);
    expect(a.overloaded).toBe(true); // over the soft capacity budget
  });

  it('flags overload (unscheduled) when work overflows the day window', () => {
    const res = planTeam({
      date: '2026-06-25',
      // A short 1-hour window can't hold two 60-min tasks back-to-back-plus.
      members: [member('A', { work_start_min: 9 * 60, work_end_min: 10 * 60 })],
      tasks: [t('t1', 60, 'A'), t('t2', 60, 'A')],
    });
    const a = res.loads[0];
    expect(a.unscheduled).toBeGreaterThan(0);
    expect(a.overloaded).toBe(true);
  });

  it('respects each member’s own work hours when scheduling', () => {
    const res = planTeam({
      date: '2026-06-25',
      members: [member('A', { work_start_min: 13 * 60, work_end_min: 17 * 60 })],
      tasks: [t('t1', 60, 'A')],
    });
    const block = res.byMember['A'].blocks[0];
    expect(block.start_min).toBeGreaterThanOrEqual(13 * 60);
  });

  it('marks every task unroutable when there are no members', () => {
    const res = planTeam({ date: '2026-06-25', members: [], tasks: [t('t1', 60)] });
    expect(res.unroutable).toEqual(['t1']);
    expect(res.loads).toEqual([]);
  });

  it('is deterministic regardless of task input order', () => {
    const tasks = [t('t1', 90), t('t2', 30), t('t3', 60), t('t4', 45)];
    const a = planTeam({ date: '2026-06-25', members: [member('A'), member('B')], tasks });
    const b = planTeam({ date: '2026-06-25', members: [member('A'), member('B')], tasks: [...tasks].reverse() });
    const norm = (r: typeof a) => r.assignments.map((x) => `${x.task_id}:${x.actor}`).sort();
    expect(norm(b)).toEqual(norm(a));
  });
});
