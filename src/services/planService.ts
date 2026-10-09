/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/planService.ts — The Planner (Act 1)
   ──────────────────────────────────────────────────────
   Gathers the day's tasks + calendar busy times + work hours, runs the
   deterministic scheduler, and persists the assigned time blocks.

   Under Tauri the solver runs in Rust (`plan_day`); in the browser/web
   fallback the identical algorithm runs here in `planLocally`, so the planner
   works offline and privately everywhere — the local-first soul.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import {
  IS_TAURI,
  initDb,
  commitPlan,
  getPlanningSnapshot,
  getAllTasks,
  getCalendarEvents,
  getSetting,

  updateScheduling,
} from '../db';
import {ensureCalendarCoverage} from './calendarSyncService';
import { useStore, type CalendarEvent, type Energy, type Task } from '../store';
import { estimateScheduling } from './aiService';
import { learnEnergyCurve } from './energyModel';

export interface PlanTask {
  id: string;
  title: string;
  duration_min: number;
  energy: Energy;
  deadline: string;
  priority: 'high' | 'medium' | 'low';
  importance: number;
  pinned: boolean;
  pinned_start_min: number | null;
}
export interface BusyBlock { start_min: number; end_min: number; title: string }
export interface PlanRequest {
  date: string;
  work_start_min: number;
  work_end_min: number;
  tasks: PlanTask[];
  busy: BusyBlock[];
  /** Act 4: a learned 24-entry hourly energy curve (ranks 0/1/2). When present
   *  it overrides the fixed circadian curve, so the plan reflects when YOU
   *  actually focus. Absent → the default `energyAt` below is used. */
  energy_curve?: number[];
}
export interface PlanBlock { task_id: string; start_min: number; end_min: number; reason: string }
export interface PlanUnscheduled { task_id: string; reason: string }
export interface PlanResult { blocks: PlanBlock[]; unscheduled: PlanUnscheduled[]; pin?: {task_id:string;duration_min:number} }

// Defaults for the planner when the user hasn't opted into custom work hours.
// We treat the broad waking day as the default planning horizon (06:00–23:00).
export const DEFAULT_WORK_START = 6 * 60;  // 06:00
export const DEFAULT_WORK_END = 23 * 60;   // 23:00
const DEFAULT_DURATION = 30;

/** Map a 1–5 effort estimate to a default block length. */
export function effortToDuration(effort: number): number {
  return [15, 30, 45, 60, 90][Math.max(1, Math.min(5, effort || 3)) - 1] ?? DEFAULT_DURATION;
}

export function minutesOf(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}
export function isoAt(date: string, min: number): string {
  if (!Number.isInteger(min) || min<0 || min>1440) throw new Error('Invalid minute of day.');
  if (min===1440) {
    const next = new Date(`${date}T00:00:00`); next.setDate(next.getDate()+1);
    const ymd = `${next.getFullYear()}-${String(next.getMonth()+1).padStart(2,'0')}-${String(next.getDate()).padStart(2,'0')}`;
    return `${ymd}T00:00:00`;
  }
  return `${date}T${String(Math.floor(min/60)).padStart(2,'0')}:${String(min%60).padStart(2,'0')}:00`;
}
/** Clip multi-day busy intervals to the selected local calendar day. */
export function busyBlocksForDate(events: CalendarEvent[], date: string): BusyBlock[] {
  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate()+1);
  return events.flatMap(event => {
    const start = new Date(event.start), end = new Date(event.end);
    if (!Number.isFinite(+start) || !Number.isFinite(+end) || end<=start) throw new Error('Calendar contains an invalid busy interval.');
    if (end<=dayStart || start>=dayEnd) return [];
    const from = start<=dayStart ? 0 : start.getHours()*60+start.getMinutes();
    const to = end>=dayEnd ? 1440 : end.getHours()*60+end.getMinutes()+Number(end.getSeconds()>0);
    // DST fall-back can repeat wall minutes: reserve the entire affected day
    // when an instant interval reverses/ambiguously crosses the local clock.
    if (start.getTimezoneOffset()!==end.getTimezoneOffset() || to<=from) return [{start_min:0,end_min:1440,title:event.title || 'Busy (clock change)'}];
    return [{start_min:from,end_min:to,title:event.title || ''}];
  });
}

export function fmtClock(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

export async function getWorkHours(): Promise<{ start: number; end: number }> {
  // If the user explicitly enabled custom work hours, use them. Otherwise
  // fall back to the user's wake/sleep settings (or the broad defaults).
  const useCustom = (await getSetting('use_custom_work_hours', '0')) === '1';
  if (useCustom) {
    const start = Number(await getSetting('work_start_min', String(DEFAULT_WORK_START))) || DEFAULT_WORK_START;
    const end = Number(await getSetting('work_end_min', String(DEFAULT_WORK_END))) || DEFAULT_WORK_END;
    return { start, end };
  }

  // Use wake/sleep bounds when work hours are not explicitly set.
  const wake = Number(await getSetting('wake_start_min', String(DEFAULT_WORK_START))) || DEFAULT_WORK_START;
  const sleep = Number(await getSetting('wake_end_min', String(DEFAULT_WORK_END))) || DEFAULT_WORK_END;
  return { start: wake, end: sleep };
}

// ── Deterministic scheduler (TS mirror of src-tauri/src/planner.rs) ──

const energyRank = (e: string): number => (e === 'hi' ? 2 : e === 'lo' ? 0 : 1);
const priorityRank = (p: string): number => (p === 'high' ? 2 : p === 'low' ? 0 : 1);
const energyAt = (min: number): number => {
  const h = Math.floor(min / 60);
  if (h <= 11) return 2;       // morning peak
  if (h === 12) return 1;      // lunch
  if (h <= 14) return 0;       // post-lunch dip
  return 1;                    // steady afternoon
};
const durOf = (t: PlanTask): number => (t.duration_min > 0 ? t.duration_min : DEFAULT_DURATION);
const deadlineKey = (d: string): string => (d ? d : '9999-12-31');
const capFirst = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

function freeWindows(ws: number, we: number, occupied: Array<[number, number]>): Array<[number, number]> {
  if (we <= ws) return [];
  const occ = occupied
    .map(([s, e]) => [Math.min(Math.max(s, ws), we), Math.min(Math.max(e, ws), we)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of occ) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const free: Array<[number, number]> = [];
  let cursor = ws;
  for (const [s, e] of merged) {
    if (s > cursor) free.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < we) free.push([cursor, we]);
  return free;
}

function reasonFor(t: PlanTask, start: number, date: string, busy: BusyBlock[], eAt: (min: number) => number): string {
  const parts: string[] = [];
  if (t.deadline) {
    if (t.deadline < date) parts.push('overdue');
    else if (t.deadline === date) parts.push('due today');
  }
  if (priorityRank(t.priority) === 2) parts.push('high priority');
  if (energyRank(t.energy) === 2 && eAt(start) === 2) parts.push('scheduled when your energy peaks');
  else if (energyRank(t.energy) === 0 && eAt(start) === 0) parts.push('low-energy work for a quieter hour');
  const after = busy.find((b) => b.end_min === start);
  if (after) parts.push(`right after ${after.title ? `"${after.title}"` : 'your calendar block'}`);
  return parts.length ? capFirst(parts.join(', ')) : 'Best available slot';
}

/** The same bounds are enforced by the native planner before solving. */
export function validatePlanRequest(req: PlanRequest): void {
  const minute = (n:number) => Number.isInteger(n) && n>=0 && n<=1440;
  const date = (s:string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0,10)===s;
  if (!date(req.date) || !minute(req.work_start_min) || !minute(req.work_end_min) || req.work_end_min<=req.work_start_min) throw new Error('Invalid planner date or working hours.');
  if (req.tasks.length>10000 || req.busy.length>10000) throw new Error('Planner input exceeds the supported size.');
  if (req.energy_curve && req.energy_curve.length && (req.energy_curve.length!==24 || req.energy_curve.some(n => !Number.isInteger(n) || n<0 || n>2))) throw new Error('Invalid energy curve.');
  const ids = new Set<string>();
  for (const task of req.tasks) {
    if (!task.id || ids.has(task.id)) throw new Error('Planner task IDs must be unique.');
    ids.add(task.id);
    if (!Number.isInteger(task.duration_min) || task.duration_min<1 || task.duration_min>1440 || !Number.isInteger(task.importance) || task.importance<1 || task.importance>5 || !['hi','med','lo'].includes(task.energy) || !['high','medium','low'].includes(task.priority) || (task.deadline && !date(task.deadline))) throw new Error('Invalid task duration, importance, energy, priority, or deadline.');
    if (task.pinned_start_min!=null && (!minute(task.pinned_start_min) || !task.pinned)) throw new Error('Invalid pinned start.');
  }
  for (const busy of req.busy) if (!minute(busy.start_min) || !minute(busy.end_min) || busy.end_min<=busy.start_min) throw new Error('Invalid busy interval.');
}

export function planLocally(req: PlanRequest): PlanResult {
  validatePlanRequest(req);
  const { work_start_min: ws, work_end_min: we } = req;
  // Prefer a learned energy curve when one was supplied; else the circadian one.
  const eAt =
    req.energy_curve && req.energy_curve.length === 24
      ? (min: number) => req.energy_curve![Math.floor(min / 60) % 24]
      : energyAt;
  const blocks: PlanBlock[] = [];
  const unscheduled: PlanUnscheduled[] = [];
  const occupied: Array<[number, number]> = req.busy.map((b) => [b.start_min, b.end_min]);

  // Pinned tasks claim fixed slots first.
  for (const t of [...req.tasks].sort((a,b) => a.id<b.id ? -1 : a.id>b.id ? 1 : 0)) {
    if (!t.pinned) continue;
    if (t.pinned_start_min == null) {
      unscheduled.push({task_id:t.id,reason:'Pinned task has no start time'});
      continue;
    }
    const s = t.pinned_start_min;
    const e = s + durOf(t);
    if (s<ws || e>we || occupied.some(([start,end]) => start<e && end>s)) {
      unscheduled.push({task_id:t.id,reason:'Pinned time conflicts with working hours, calendar, or another pin'});
      continue;
    }
    occupied.push([s,e]);
    blocks.push({task_id:t.id,start_min:s,end_min:e,reason:'Pinned to this time'});
  }

  const pending = req.tasks
    .filter((t) => !t.pinned)
    .sort(
      (a, b) =>
        deadlineKey(a.deadline).localeCompare(deadlineKey(b.deadline)) ||
        priorityRank(b.priority) - priorityRank(a.priority) ||
        b.importance - a.importance ||
        energyRank(b.energy) - energyRank(a.energy) ||
        durOf(b) - durOf(a) ||
        (a.id<b.id ? -1 : a.id>b.id ? 1 : 0)
    );

  const free = freeWindows(ws, we, occupied);
  for (const t of pending) {
    const dur = durOf(t);
    const rank = energyRank(t.energy);
    let chosen = free.findIndex(([s, e]) => e - s >= dur && eAt(s) >= rank);
    if (chosen < 0) chosen = free.findIndex(([s, e]) => e - s >= dur);
    if (chosen < 0) {
      unscheduled.push({ task_id: t.id, reason: 'No free time left in your working hours' });
      continue;
    }
    const [s, e] = free[chosen];
    const end = s + dur;
    if (end >= e) free.splice(chosen, 1);
    else free[chosen] = [end, e];
    blocks.push({ task_id: t.id, start_min: s, end_min: end, reason: reasonFor(t, s, req.date, req.busy, eAt) });
  }

  blocks.sort((a, b) => a.start_min - b.start_min || (a.task_id<b.task_id ? -1 : a.task_id>b.task_id ? 1 : 0));
  return { blocks, unscheduled };
}

// ── Orchestration ───────────────────────────────────────

function buildRequest(
  date: string,
  tasks: Task[],
  work: { start: number; end: number },
  busy: BusyBlock[],
  energyCurve?: number[] | null
): PlanRequest {
  return {
    date,
    work_start_min: work.start,
    work_end_min: work.end,
    busy,
    energy_curve: energyCurve ?? undefined,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      duration_min: t.duration_min && t.duration_min > 0 ? t.duration_min : effortToDuration(t.effort),
      energy: (t.energy as Energy) || 'med',
      deadline: t.deadline || '',
      priority: t.priority || 'medium',
      importance: t.importance || 3,
      pinned: !!t.pinned,
      pinned_start_min:
        t.pinned && t.scheduled_start && String(t.scheduled_start).slice(0, 10) === date
          ? minutesOf(t.scheduled_start)
          : null,
    })),
  };
}

export interface PlanOptions {
  /** Earliest minute a new block may start (used by mid-day reflow). */
  fromMin?: number;
  signal?: AbortSignal;
  pin?: {taskId:string;startMin:number;durationMin:number};
}

/**
 * Auto-plan `date`: solve, persist the assigned blocks (clearing the prior
 * day's non-pinned schedule first), and reflect everything in the store.
 *
 * `fromMin` lets a mid-day reflow plan only the *remaining* hours so slipped
 * work moves forward rather than being re-laid into the past.
 */
export class PlanRefreshError extends Error {
  constructor() {super('Plan saved, but the screen could not refresh. Reload before making further changes.');this.name='PlanRefreshError';}
}

export async function planDay(date: string, opts: PlanOptions = {}): Promise<PlanResult> {
  if (opts.signal?.aborted) throw new Error('Planning cancelled.');
  await initDb();
  if (opts.signal?.aborted) throw new Error('Planning cancelled.');
  await ensureCalendarCoverage(date);
  if(opts.signal?.aborted) throw new Error('Planning cancelled.');
  const snapshot = await getPlanningSnapshot();
  const open = snapshot.tasks.filter(t => !t.done && !t.parent_id && !t.deleted_at).map(task => opts.pin?.taskId===task.id ? {...task,pinned:true,duration_min:opts.pin.durationMin,scheduled_start:isoAt(date,opts.pin.startMin)} : task);
  if (opts.pin && !open.some(task=>task.id===opts.pin!.taskId)) throw new Error('Only an open task can be moved into this plan.');
  const settings = snapshot.settings;
  const custom = settings.use_custom_work_hours==='1';
  const work = {
    start:Number(settings[custom ? 'work_start_min' : 'wake_start_min'] ?? DEFAULT_WORK_START),
    end:Number(settings[custom ? 'work_end_min' : 'wake_end_min'] ?? DEFAULT_WORK_END),
  };
  const start = opts.fromMin != null ? Math.max(work.start,opts.fromMin) : work.start;
  if (start>=work.end) return {blocks:[],unscheduled:open.map(t => ({task_id:t.id,reason:'Working hours have ended'}))};
  const completed = snapshot.tasks.filter(task => task.done && !task.deleted_at && task.scheduled_start && task.scheduled_end)
    .map(task=>({id:task.id,title:`Completed: ${task.title}`,start:task.scheduled_start!,end:task.scheduled_end!,source:'completed',created_at:''}));
  const busy = busyBlocksForDate([...snapshot.calendar,...completed],date);
  const energyCurve = learnEnergyCurve(snapshot.tasks);
  const req = buildRequest(date,open,{start,end:work.end},busy,energyCurve);
  validatePlanRequest(req);

  let result: PlanResult;
  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core');
    result = await invoke<PlanResult>('plan_day', { req });
  } else {
    result = planLocally(req);
  }

  if (opts.pin) {
    const placed = result.blocks.find(block=>block.task_id===opts.pin!.taskId);
    if (!placed) throw new Error(result.unscheduled.find(item=>item.task_id===opts.pin!.taskId)?.reason || 'Pinned time is unavailable.');
    result.pin={task_id:opts.pin.taskId,duration_min:opts.pin.durationMin};
  }
  if (opts.signal?.aborted) throw new Error('Planning cancelled.');
  await commitPlan(date,result,snapshot);
  try {useStore.getState().setTasks(await getAllTasks(useStore.getState().currentFilter) as Task[]);}
  catch {throw new PlanRefreshError();}
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('plan-changed'));
  return result;
}

// ── Auto-reflow: keep the plan honest as reality shifts ──

export interface Disruption { reason: string }

/**
 * Has today's plan drifted out of sync with reality? Pure over its inputs.
 *
 *  - **collision** — a scheduled, not-done task now overlaps a calendar event
 *    (a meeting appeared on top of planned work)
 *  - **slip** — a scheduled, not-done task's block has fully elapsed
 *    (it ran over; everything after it should shift forward)
 *
 * Returns the first disruption found, or null when the plan still holds.
 */
export function detectDisruption(
  tasks: Task[],
  events: CalendarEvent[],
  date: string,
  nowMin: number
): Disruption | null {
  const onDate = (iso?: string | null) => !!iso && String(iso).slice(0, 10) === date;

  const scheduled = tasks
    .filter((t) => !t.done && !t.deleted_at && onDate(t.scheduled_start))
    .map((t) => ({
      t,
      start: minutesOf(t.scheduled_start!),
      end: t.scheduled_end ? minutesOf(t.scheduled_end) : minutesOf(t.scheduled_start!) + 30,
    }));

  const busy = busyBlocksForDate(events,date).map(b => ({title:b.title,start:b.start_min,end:b.end_min}));

  for (const s of scheduled) {
    const hit = busy.find((b) => b.start < s.end && b.end > s.start);
    if (hit) return { reason: hit.title ? `"${hit.title}"` : 'a calendar event' };
  }
  for (const s of scheduled) {
    if (s.end <= nowMin) return { reason: `"${s.t.title}" running over` };
  }
  return null;
}

/**
 * AI advisor: estimate duration + energy for open tasks that lack a sized
 * block, and persist the estimates so the next plan is sharper. Desktop +
 * API-key only (throws otherwise); the deterministic defaults already cover
 * everyone else. Returns how many tasks were enriched.
 */
export async function enrichScheduling(): Promise<number> {
  const open = useStore
    .getState()
    .currentTasks.filter((t) => !t.done && !t.parent_id && !t.deleted_at);
  // Only spend tokens on tasks the user hasn't sized themselves.
  const needsSizing = open.filter((t) => !(t.duration_min && t.duration_min > 0));
  if (needsSizing.length === 0) return 0;

  const estimates = await estimateScheduling(
    needsSizing.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      tags: t.tags,
      importance: t.importance || 3,
      effort: t.effort || 3,
    }))
  );

  for (const e of estimates) {
    const t = open.find((x) => x.id === e.id);
    await updateScheduling(e.id, { duration_min: e.duration_min, energy: e.energy, pinned: !!t?.pinned });
    useStore.getState().updateTaskOptimistic(e.id, { duration_min: e.duration_min, energy: e.energy } as Partial<Task>);
  }
  return estimates.length;
}

/** Current local time as minutes-since-midnight. */
export function nowMinutes(d: Date = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * Re-plan today only if reality has drifted. Returns the disruption that
 * triggered the re-plan (with the fresh result), or null if nothing changed.
 */
export async function reflowIfDisrupted(
  date: string, signal?: AbortSignal
): Promise<{ disruption: Disruption; result: PlanResult } | null> {
  const tasks = await getAllTasks('all') as Task[];
  const events = await getCalendarEvents();
  const now = nowMinutes();
  const disruption = detectDisruption(tasks, events, date, now);
  if (!disruption) return null;
  const result = await planDay(date, { fromMin: now, signal });
  return { disruption, result };
}
