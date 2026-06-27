/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/teamPlanService.ts — team auto-planning (Act 3)
   ──────────────────────────────────────────────────────
   The planner moat becomes a team moat: extend single-person scheduling with
   multi-person constraints + workload balancing — what Asana/ClickUp do poorly.

   Two deterministic phases (pure, so they're exhaustively testable):
     1. BALANCE — tasks with an assignee stay with them; unassigned tasks are
        distributed greedily to the least-loaded member who still has capacity
        (highest-priority first), so no one is overloaded while others idle.
     2. SCHEDULE — each member's resulting task set is laid out with the SAME
        deterministic solver as solo planning (planLocally), against that
        member's work hours + calendar busy blocks.

   Output includes a per-member load report (scheduled vs capacity, overload
   flag) so a team can see — and the UI can surface — an even week.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import {
  planLocally, effortToDuration,
  DEFAULT_WORK_START, DEFAULT_WORK_END,
  type PlanTask, type BusyBlock, type PlanResult,
} from './planService';

const DEFAULT_DURATION = 30;
const durOf = (t: { duration_min: number }) => (t.duration_min > 0 ? t.duration_min : DEFAULT_DURATION);
const priorityRank = (p: string): number => (p === 'high' ? 2 : p === 'low' ? 0 : 1);
const deadlineKey = (d: string): string => (d ? d : '9999-12-31');

export interface TeamMember {
  actor: string;
  work_start_min?: number;
  work_end_min?: number;
  busy?: BusyBlock[];
  /** Schedulable minutes available this horizon. Defaults to the work window. */
  capacity_min?: number;
}

export interface TeamPlanTask extends PlanTask {
  /** The member this task is assigned to, or null to let the balancer place it. */
  assignee: string | null;
}

export interface TeamPlanRequest {
  date: string;
  members: TeamMember[];
  tasks: TeamPlanTask[];
}

export interface MemberLoad {
  actor: string;
  capacity_min: number;
  assigned_min: number;    // total estimated work routed to this member
  scheduled_min: number;   // what actually fit in the day
  unscheduled: number;     // tasks that didn't fit
  overloaded: boolean;     // assigned beyond capacity, or something didn't fit
}

export interface TeamAssignment { task_id: string; actor: string }

export interface TeamPlanResult {
  /** Per-member schedule (actor → PlanResult). */
  byMember: Record<string, PlanResult>;
  /** Per-member workload report, ordered by actor for determinism. */
  loads: MemberLoad[];
  /** Tasks the balancer auto-assigned (assignee was null), for optional apply. */
  assignments: TeamAssignment[];
  /** Tasks that couldn't be routed (no members at all). */
  unroutable: string[];
}

const capacityOf = (m: TeamMember): number =>
  m.capacity_min ?? ((m.work_end_min ?? DEFAULT_WORK_END) - (m.work_start_min ?? DEFAULT_WORK_START));

/** Highest-priority-first ordering (mirrors planLocally's pending sort). */
function byPriority(a: TeamPlanTask, b: TeamPlanTask): number {
  return (
    deadlineKey(a.deadline).localeCompare(deadlineKey(b.deadline)) ||
    priorityRank(b.priority) - priorityRank(a.priority) ||
    b.importance - a.importance ||
    durOf(b) - durOf(a) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Deterministic team plan: balance unassigned work by capacity, then schedule
 * each member with the solo solver. Pure — no DB, network, or store.
 */
export function planTeam(req: TeamPlanRequest): TeamPlanResult {
  const members = [...req.members].sort((a, b) => a.actor.localeCompare(b.actor));
  const unroutable: string[] = [];

  if (members.length === 0) {
    return { byMember: {}, loads: [], assignments: [], unroutable: req.tasks.map((t) => t.id) };
  }

  const buckets = new Map<string, TeamPlanTask[]>(members.map((m) => [m.actor, []]));
  const load = new Map<string, number>(members.map((m) => [m.actor, 0]));
  const assignments: TeamAssignment[] = [];

  // Phase 1a — honour explicit assignments.
  const free: TeamPlanTask[] = [];
  for (const t of req.tasks) {
    if (t.assignee && buckets.has(t.assignee)) {
      buckets.get(t.assignee)!.push(t);
      load.set(t.assignee, load.get(t.assignee)! + durOf(t));
    } else {
      free.push(t);
    }
  }

  // Phase 1b — distribute the rest to the least-loaded member with room.
  for (const t of [...free].sort(byPriority)) {
    const d = durOf(t);
    // Prefer members who stay within capacity; tie-break on lowest resulting load.
    const pick = members
      .map((m) => ({ m, after: load.get(m.actor)! + d, cap: capacityOf(m) }))
      .sort((a, b) => {
        const aFits = a.after <= a.cap ? 0 : 1;
        const bFits = b.after <= b.cap ? 0 : 1;
        return aFits - bFits || a.after - b.after || a.m.actor.localeCompare(b.m.actor);
      })[0].m;
    buckets.get(pick.actor)!.push(t);
    load.set(pick.actor, load.get(pick.actor)! + d);
    assignments.push({ task_id: t.id, actor: pick.actor });
  }

  // Phase 2 — schedule each member's bucket with the deterministic solver.
  const byMember: Record<string, PlanResult> = {};
  const loads: MemberLoad[] = [];
  for (const m of members) {
    const tasks = buckets.get(m.actor)!.map(stripAssignee);
    const result = planLocally({
      date: req.date,
      work_start_min: m.work_start_min ?? DEFAULT_WORK_START,
      work_end_min: m.work_end_min ?? DEFAULT_WORK_END,
      tasks,
      busy: m.busy ?? [],
    });
    byMember[m.actor] = result;

    const assigned_min = load.get(m.actor)!;
    const scheduled_min = result.blocks.reduce((sum, b) => sum + (b.end_min - b.start_min), 0);
    const cap = capacityOf(m);
    loads.push({
      actor: m.actor,
      capacity_min: cap,
      assigned_min,
      scheduled_min,
      unscheduled: result.unscheduled.length,
      overloaded: assigned_min > cap || result.unscheduled.length > 0,
    });
  }

  return { byMember, loads, assignments, unroutable };
}

function stripAssignee(t: TeamPlanTask): PlanTask {
  const { assignee: _omit, ...rest } = t;
  return rest;
}

/** Map a Task-ish record to a TeamPlanTask (duration from effort if unset). */
export function toTeamPlanTask(t: {
  id: string; title: string; duration_min?: number; energy?: string; deadline?: string;
  priority?: string; importance?: number; pinned?: boolean; effort?: number;
}, assignee: string | null): TeamPlanTask {
  return {
    id: t.id,
    title: t.title,
    duration_min: t.duration_min && t.duration_min > 0 ? t.duration_min : effortToDuration(t.effort ?? 3),
    energy: ((t.energy as TeamPlanTask['energy']) || 'med'),
    deadline: t.deadline || '',
    priority: (t.priority as TeamPlanTask['priority']) || 'medium',
    importance: t.importance ?? 3,
    pinned: !!t.pinned,
    pinned_start_min: null,
    assignee,
  };
}
