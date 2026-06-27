import { describe, it, expect } from 'vitest';
import { learnEnergyCurve, energyRankAt } from './energyModel';
import type { Task } from '../store';

function done(hour: number, pomodoros: number): Task {
  const hh = String(hour).padStart(2, '0');
  return {
    id: Math.random().toString(36).slice(2), title: 'T', description: '', tags: [], deadline: '',
    importance: 3, effort: 3, done: true, created_at: '2026-06-01', completed_at: '2026-06-20T00:00:00',
    pomodoros_spent: pomodoros, priority: 'medium', sort_order: 0, project_id: null, parent_id: null,
    recurrence: 'none', milestone_id: null, custom_fields: {}, deleted_at: null,
    duration_min: 0, scheduled_start: `2026-06-20T${hh}:00:00`, scheduled_end: null, energy: 'med', pinned: false,
  };
}

describe('energyModel.learnEnergyCurve', () => {
  it('returns null until there is enough signal', () => {
    expect(learnEnergyCurve([])).toBeNull();
    expect(learnEnergyCurve([done(9, 1), done(10, 1)], 4)).toBeNull(); // only 2 samples
  });

  it('learns the user’s peak hours and ranks them above quiet ones', () => {
    // Heavy focus at 14–15h, light at 9h.
    const curve = learnEnergyCurve([
      done(14, 4), done(14, 3), done(15, 4), done(15, 2), done(9, 1),
    ], 4)!;
    expect(curve).toHaveLength(24);
    expect(energyRankAt(curve, 14 * 60)).toBe(2); // afternoon peak (learned)
    expect(energyRankAt(curve, 15 * 60)).toBe(2);
    expect(energyRankAt(curve, 9 * 60)).toBe(0);  // their low hour
    expect(energyRankAt(curve, 3 * 60)).toBe(1);  // no data → neutral
  });

  it('ignores unfocused or incomplete work', () => {
    const t = done(10, 0); // no pomodoros
    expect(learnEnergyCurve([t, t, t, t], 4)).toBeNull();
  });
});
