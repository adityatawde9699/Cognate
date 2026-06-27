/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/onboardingService.ts — 60-second first-run magic (Act 5)
   ──────────────────────────────────────────────────────
   The first impression: import a calendar (or seed a few starter tasks) and a
   planned day appears immediately — the "switch moment" with zero setup. The
   decision + starter set are pure/testable; `quickStart` wires them to the real
   ingest + planner so the magic is the actual product, not a mock.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting, setSetting } from '../db';
import { importBusyText } from './calendarSyncService';
import { addTask, loadAllTasks, type TaskInput } from './taskService';
import { planDay } from './planService';
import { useStore } from '../store';

const ONBOARDED_KEY = 'onboarded';

/** A handful of starter tasks that show off energy- and deadline-aware planning. */
export const STARTER_TASKS: (TaskInput & { energy: 'hi' | 'med' | 'lo'; duration_min: number })[] = [
  { title: 'Plan your week', description: '', deadline: '', tags: ['focus'], importance: 4, effort: 2, energy: 'hi', duration_min: 30 },
  { title: 'Deep work on your top priority', description: '', deadline: '', tags: ['focus'], importance: 5, effort: 4, energy: 'hi', duration_min: 90 },
  { title: 'Clear your inbox', description: '', deadline: '', tags: ['admin'], importance: 2, effort: 2, energy: 'lo', duration_min: 30 },
  { title: 'Take a walk', description: '', deadline: '', tags: ['health'], importance: 1, effort: 1, energy: 'lo', duration_min: 30 },
];

/** Pure: does this install still need the first-run flow? */
export function firstRunNeeded(onboardedFlag: string): boolean {
  return onboardedFlag !== '1';
}

export async function isOnboarded(): Promise<boolean> {
  return !firstRunNeeded((await getSetting(ONBOARDED_KEY, '')) || '');
}
export async function markOnboarded(): Promise<void> {
  await setSetting(ONBOARDED_KEY, '1');
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface QuickStartResult { busy: number; created: number; planned: number }

/**
 * The magic: optionally ingest pasted calendar text, ensure there's something
 * to plan, auto-plan today, and mark onboarding done. Returns what happened.
 */
export async function quickStart(opts: { icsText?: string; addStarters?: boolean } = {}): Promise<QuickStartResult> {
  let busy = 0;
  if (opts.icsText && opts.icsText.trim()) {
    try { busy = await importBusyText(opts.icsText); } catch { /* bad paste — continue */ }
  }

  await loadAllTasks('all');
  const open = useStore.getState().currentTasks.filter((t) => !t.done && !t.deleted_at);

  let created = 0;
  if (opts.addStarters && open.length === 0) {
    for (const t of STARTER_TASKS) {
      const made = await addTask(t);
      if (made) created++;
    }
  }

  const result = await planDay(localToday());
  await markOnboarded();
  return { busy, created, planned: result.blocks.length };
}
