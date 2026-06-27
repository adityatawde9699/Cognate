/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/quickAddService.ts — turn an NL line into a real task (Act 4)
   ──────────────────────────────────────────────────────
   Bridges the pure parser (nlQuickAdd) to the CQRS create pipeline: build a
   TaskInput, create it, and — when an explicit clock time was given — place and
   PIN the block so the planner keeps it exactly where you said. Everything is
   deterministic and offline; the op-log records it like any other mutation.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { parseQuickAdd, mergeQuickAdd } from './nlQuickAdd';
import { addTask } from './taskService';
import { isoAt, effortToDuration } from './planService';
import { hasAi, quickAddParseAI } from './aiService';
import { setSchedule, setPinned, getLocalDateString, getSetting } from '../db';
import { useStore, type Task } from '../store';
import { logTaskUpsert } from './oplogStore';

export interface QuickAddOutcome {
  ok: boolean;
  task?: Task;
  scheduled: boolean;
}

/**
 * Parse `input` and create the task. Deterministic by default (offline, no
 * latency); when "Smart quick-add" is on and AI is available, an AI pass fills
 * any gaps the parser left (the deterministic parse still wins where it found
 * something). `opts.ai` overrides the setting (e.g. for tests).
 */
export async function quickAdd(input: string, opts: { ai?: boolean } = {}): Promise<QuickAddOutcome> {
  let r = parseQuickAdd(input);

  const useAi = opts.ai ?? ((await getSetting('quickadd_ai', '0')) === '1');
  if (useAi && (await hasAi())) {
    const ai = await quickAddParseAI(input);
    r = mergeQuickAdd(r, ai);
  }
  if (!r.title) return { ok: false, scheduled: false };

  const task = await addTask({
    title: r.title,
    description: '',
    deadline: r.deadline,
    tags: r.tags,
    importance: r.importance,
    effort: 3,
    recurrence: 'none',
    duration_min: r.durationMin ?? undefined,
  });
  if (!task) return { ok: false, scheduled: false };

  // No explicit time → leave it in the backlog for the next auto-plan to place.
  if (r.startMin === null) return { ok: true, task, scheduled: false };

  // Explicit time → pin a concrete block (on the parsed date, else today).
  const date = r.deadline || getLocalDateString();
  const dur = r.durationMin ?? effortToDuration(3);
  const start = isoAt(date, r.startMin);
  const end = isoAt(date, r.startMin + dur);
  try {
    await setSchedule(task.id, start, end);
    await setPinned(task.id, true);
    const patch: Partial<Task> = { scheduled_start: start, scheduled_end: end, pinned: true, duration_min: dur };
    useStore.getState().updateTaskOptimistic(task.id, patch);
    void logTaskUpsert({ ...task, ...patch });
    return { ok: true, task: { ...task, ...patch }, scheduled: true };
  } catch {
    // Scheduling is best-effort; the task itself was created.
    return { ok: true, task, scheduled: false };
  }
}
