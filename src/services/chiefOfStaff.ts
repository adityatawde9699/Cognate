/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/chiefOfStaff.ts — the proactive layer (Act 4)
   ──────────────────────────────────────────────────────
   "Thinks one step ahead": a morning brief, an overcommitment warning, and an
   end-of-day review — all DETERMINISTIC and pure (data → facts), so the nudges
   are trustworthy and work offline/privately. AI may later narrate these facts
   into prose, but the facts and the suggested move come from here.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import type { Task } from '../store';

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (iso?: string | null) => (iso ? String(iso).slice(0, 10) : '');
const minOfIso = (iso: string) => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };

const EFFORT_MIN = [15, 30, 45, 60, 90];
/** Best estimate of a task's length in minutes (a placed block, else duration/effort). */
export function estimateMinutes(t: Task): number {
  if (t.scheduled_start && t.scheduled_end) {
    const d = minOfIso(t.scheduled_end) - minOfIso(t.scheduled_start);
    if (d > 0) return d;
  }
  if (t.duration_min && t.duration_min > 0) return t.duration_min;
  return EFFORT_MIN[Math.max(1, Math.min(5, t.effort || 3)) - 1];
}

function clock(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
}
const live = (t: Task) => !t.done && !t.deleted_at;

// ── Morning brief ────────────────────────────────────────

export interface ScheduledBlock { task: Task; startMin: number }
export interface Brief {
  date: string;
  dueToday: Task[];
  overdue: Task[];
  scheduled: ScheduledBlock[];
  firstBlockMin: number | null;
  scheduledMinutes: number;
  headline: string;
}

export function morningBrief(tasks: Task[], now: Date = new Date()): Brief {
  const today = ymd(now);
  const open = tasks.filter(live);
  const dueToday = open.filter((t) => t.deadline === today);
  const overdue = open.filter((t) => t.deadline && t.deadline < today);
  const scheduled = open
    .filter((t) => t.scheduled_start && dateOf(t.scheduled_start) === today)
    .map((t) => ({ task: t, startMin: minOfIso(t.scheduled_start!) }))
    .sort((a, b) => a.startMin - b.startMin);
  const scheduledMinutes = scheduled.reduce((s, b) => s + estimateMinutes(b.task), 0);
  const firstBlockMin = scheduled.length ? scheduled[0].startMin : null;

  const bits: string[] = [];
  if (scheduled.length) bits.push(`${scheduled.length} block${scheduled.length === 1 ? '' : 's'} planned`);
  if (firstBlockMin !== null) bits.push(`first at ${clock(firstBlockMin)}`);
  if (dueToday.length) bits.push(`${dueToday.length} due today`);
  if (overdue.length) bits.push(`${overdue.length} overdue`);
  const headline = bits.length ? bits.join(' · ') : 'Nothing scheduled yet — auto-plan your day?';

  return { date: today, dueToday, overdue, scheduled, firstBlockMin, scheduledMinutes, headline };
}

// ── Overcommitment ───────────────────────────────────────

export interface Overcommit {
  date: string;
  capacityMin: number;
  committedMin: number;
  overBy: number;        // minutes beyond capacity (0 if fine)
  isOvercommitted: boolean;
  suggestions: Task[];   // least-important committed work to move, enough to fit
}

/**
 * Is `date` overcommitted? Sums the estimated length of open work either placed
 * on that day or due that day against the working-hours capacity, and proposes
 * the least-important tasks to move until it fits.
 */
export function detectOvercommit(
  tasks: Task[],
  work: { start: number; end: number },
  date: string
): Overcommit {
  const capacityMin = Math.max(0, work.end - work.start);
  const committed = tasks.filter(
    (t) => live(t) && ((t.scheduled_start && dateOf(t.scheduled_start) === date) || t.deadline === date)
  );
  const committedMin = committed.reduce((s, t) => s + estimateMinutes(t), 0);
  const overBy = Math.max(0, committedMin - capacityMin);

  const suggestions: Task[] = [];
  if (overBy > 0) {
    const pr = { low: 0, medium: 1, high: 2 } as const;
    const byLeastImportant = [...committed].sort(
      (a, b) => (a.importance || 0) - (b.importance || 0) || pr[a.priority] - pr[b.priority] || estimateMinutes(b) - estimateMinutes(a)
    );
    let freed = 0;
    for (const t of byLeastImportant) {
      if (freed >= overBy) break;
      suggestions.push(t);
      freed += estimateMinutes(t);
    }
  }
  return { date, capacityMin, committedMin, overBy, isOvercommitted: overBy > 0, suggestions };
}

// ── End-of-day review ────────────────────────────────────

export interface DayReview {
  date: string;
  completed: Task[];
  slipped: Task[];      // planned for today but not done
  focusCount: number;   // pomodoros logged on today's completed work
  onPlanCount: number;  // completed tasks that were actually scheduled today
  headline: string;
}

export function endOfDayReview(tasks: Task[], now: Date = new Date()): DayReview {
  const today = ymd(now);
  const completed = tasks.filter((t) => t.done && dateOf(t.completed_at) === today);
  const slipped = tasks.filter((t) => !t.done && !t.deleted_at && t.scheduled_start && dateOf(t.scheduled_start) === today);
  const focusCount = completed.reduce((s, t) => s + (t.pomodoros_spent || 0), 0);
  const onPlanCount = completed.filter((t) => t.scheduled_start && dateOf(t.scheduled_start) === today).length;

  const headline =
    completed.length === 0 && slipped.length === 0
      ? 'A quiet day on the plan.'
      : `Done ${completed.length}` +
        (slipped.length ? ` · ${slipped.length} slipped to tomorrow` : '') +
        (focusCount ? ` · ${focusCount} focus session${focusCount === 1 ? '' : 's'}` : '');

  return { date: today, completed, slipped, focusCount, onPlanCount, headline };
}
