import { describe, it, expect, beforeEach } from 'vitest';
import { firstRunNeeded, STARTER_TASKS, isOnboarded, quickStart } from './onboardingService';
import { useStore } from '../store';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

describe('onboarding — pure first-run decision', () => {
  it('needs the flow until the flag is set', () => {
    expect(firstRunNeeded('')).toBe(true);
    expect(firstRunNeeded('1')).toBe(false);
  });

  it('starter tasks are varied enough to show off the planner', () => {
    expect(STARTER_TASKS.length).toBeGreaterThanOrEqual(3);
    const energies = new Set(STARTER_TASKS.map((t) => t.energy));
    expect(energies.has('hi')).toBe(true);
    expect(energies.has('lo')).toBe(true);
    expect(STARTER_TASKS.every((t) => t.title && t.duration_min > 0)).toBe(true);
  });
});

describe('onboarding — quickStart magic', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemStorage();
    useStore.setState({ currentTasks: [], currentFilter: 'plan' });
  });

  it('plans the day and marks onboarded (the magic)', async () => {
    expect(await isOnboarded()).toBe(false);
    const r = await quickStart({ addStarters: true });
    // Either starters were added (empty install) or seed tasks already existed;
    // either way a real plan comes out and onboarding won't show again.
    expect(r.created + useStore.getState().currentTasks.length).toBeGreaterThan(0);
    expect(r.planned).toBeGreaterThan(0);
    expect(await isOnboarded()).toBe(true);
  });

  it('ingests pasted calendar busy time', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Standup',
      'DTSTART:20260625T140000Z',
      'DTEND:20260625T143000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');
    const r = await quickStart({ icsText: ics, addStarters: true });
    expect(r.busy).toBe(1);
  });
});
