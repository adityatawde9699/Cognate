import { describe, it, expect } from 'vitest';
import { nextDeadline } from './taskService';

describe('nextDeadline', () => {
  it('rolls a daily deadline forward one day', () => {
    expect(nextDeadline('2026-06-24', 'daily')).toBe('2026-06-25');
  });

  it('rolls a weekly deadline forward seven days', () => {
    expect(nextDeadline('2026-06-24', 'weekly')).toBe('2026-07-01');
  });

  it('rolls a monthly deadline forward one month', () => {
    expect(nextDeadline('2026-06-24', 'monthly')).toBe('2026-07-24');
  });

  it('handles month-end rollover for monthly', () => {
    // Jan 31 + 1 month → JS normalizes to Mar 3 (non-leap 2026)
    expect(nextDeadline('2026-01-31', 'monthly')).toBe('2026-03-03');
  });
});
