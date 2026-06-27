/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/energyModel.ts — the closed focus→energy→plan loop (Act 4)
   ──────────────────────────────────────────────────────
   The vertical-integration moat: learn WHEN you actually do focused work from
   your own history (completed tasks × pomodoros at their scheduled hour) and
   feed that personal energy curve back into the planner, so future days place
   demanding work in the hours you're genuinely sharp. The more you use it, the
   better it plans — a data-network-effect-of-one. Pure + unit-tested; the
   planner falls back to the fixed circadian curve until there's enough signal.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import type { Task } from '../store';

const POMODORO_MIN = 25;

/**
 * Learn a 24-entry hourly energy curve (ranks 0=low, 1=neutral, 2=peak) from
 * completed, focused, scheduled work. Returns null until there's enough signal
 * (so the planner keeps its sensible default). Hours with no history stay
 * neutral; hours with logged focus are ranked against the user's own terciles.
 */
export function learnEnergyCurve(tasks: Task[], minSamples = 4): number[] | null {
  const minutes = new Array(24).fill(0);
  let samples = 0;
  for (const t of tasks) {
    if (t.done && t.scheduled_start && (t.pomodoros_spent ?? 0) > 0) {
      const h = new Date(t.scheduled_start).getHours();
      if (h >= 0 && h < 24) {
        minutes[h] += (t.pomodoros_spent || 1) * POMODORO_MIN;
        samples++;
      }
    }
  }
  if (samples < minSamples) return null;

  const max = Math.max(...minutes);
  if (max <= 0) return null;

  // Rank each hour relative to your busiest hour: the top band is "peak", the
  // bottom band "low", the middle "neutral" — robust even on small samples.
  return minutes.map((v) => {
    if (v <= 0) return 1;             // no data → neutral
    if (v >= 0.6 * max) return 2;     // your peak hours
    if (v <= 0.3 * max) return 0;     // your low hours
    return 1;
  });
}

/** The energy rank for a minute-of-day against a learned curve. */
export function energyRankAt(curve: number[], min: number): number {
  return curve[Math.floor(min / 60) % 24] ?? 1;
}
