import { describe, it, expect, beforeEach, vi } from 'vitest';

// Drive the real CQRS create path against the localStorage fallback.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// Mock the AI layer so the enrichment path is deterministic in tests.
vi.mock('./aiService', () => ({
  hasAi: vi.fn(async () => true),
  quickAddParseAI: vi.fn(async () => ({ deadline: '2026-06-30', startMin: 9 * 60, durationMin: 45, importance: 5, tags: ['ai'] })),
}));

import { quickAdd } from './quickAddService';
import { useStore } from '../store';
import { getAllTasks } from '../db';

describe('quickAddService', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemStorage();
    useStore.setState({ currentTasks: [] });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 25, 10, 0, 0)); // Thu 2026-06-25 10:00
  });

  it('creates a backlog task from a plain line (no time)', async () => {
    const out = await quickAdd('buy milk #errands');
    expect(out.ok).toBe(true);
    expect(out.scheduled).toBe(false);
    expect(out.task!.title).toBe('buy milk');
    expect(out.task!.tags).toEqual(['errands']);
    const rows = (await getAllTasks('all')) as any[];
    expect(rows.find((t) => t.title === 'buy milk')).toBeTruthy();
  });

  it('creates AND pins a scheduled block when a time is given', async () => {
    const out = await quickAdd('call Sam tmrw 5pm 30m #work');
    expect(out.ok).toBe(true);
    expect(out.scheduled).toBe(true);
    expect(out.task!.title).toBe('call Sam');
    expect(out.task!.pinned).toBe(true);
    expect(out.task!.scheduled_start).toBe('2026-06-26T17:00:00');
    expect(out.task!.scheduled_end).toBe('2026-06-26T17:30:00'); // 30m duration
    // Reflected in the store for the open view.
    const inStore = useStore.getState().currentTasks.find((t) => t.id === out.task!.id);
    expect(inStore?.scheduled_start).toBe('2026-06-26T17:00:00');
  });

  it('refuses an empty / signal-only line', async () => {
    expect((await quickAdd('   ')).ok).toBe(false);
    expect((await quickAdd('#work')).ok).toBe(false); // no title left
  });

  it('AI enrichment fills gaps the parser left (opt-in)', async () => {
    // "lunch with Dana" has no date/time → the mocked AI supplies them.
    const out = await quickAdd('lunch with Dana', { ai: true });
    expect(out.ok).toBe(true);
    expect(out.scheduled).toBe(true); // AI gave a startMin → a pinned block
    expect(out.task!.title).toBe('lunch with Dana');
    expect(out.task!.scheduled_start).toBe('2026-06-30T09:00:00');
    expect(out.task!.tags).toContain('ai');
  });
});
