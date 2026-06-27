import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Minimal localStorage + crypto polyfills ──────────────
// db.js falls back to localStorage when not running under Tauri (IS_TAURI is
// false in this node env because `window` is undefined). These let the real
// persistence layer run end-to-end in tests.
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
vi.stubGlobal('localStorage', new MemoryStorage());
if (!globalThis.crypto?.randomUUID) {
  let n = 0;
  vi.stubGlobal('crypto', { randomUUID: () => `uuid-${++n}` } as Crypto);
}

import { useStore } from '../store';
import { clearHistory } from './history';
import {
  addTask,
  editTask,
  removeTask,
  loadTrash,
  restoreFromTrash,
  emptyTrash,
  undoLast,
  redoLast,
} from './taskService';
import { getAllTasks } from '../db';

const baseInput = {
  title: 'Test task',
  description: '',
  deadline: '',
  tags: [] as string[],
  importance: 3,
  effort: 3,
  recurrence: 'none' as const,
};

async function liveTitles() {
  return (await getAllTasks('all')).map((t: any) => t.title);
}
async function trashTitles() {
  return (await getAllTasks('trash')).map((t: any) => t.title);
}

describe('soft-delete + inverse-op history (taskService ↔ db)', () => {
  beforeEach(() => {
    localStorage.clear();
    clearHistory();
    useStore.setState({ currentTasks: [], appError: null });
  });

  it('soft-deletes to Trash, keeping the row recoverable (not purged)', async () => {
    await addTask({ ...baseInput, title: 'Keepable' });
    const id = useStore.getState().currentTasks[0].id;

    await removeTask(id);

    expect(await liveTitles()).not.toContain('Keepable');
    expect(await trashTitles()).toContain('Keepable');
    expect(useStore.getState().currentTasks.find((t) => t.id === id)).toBeUndefined();
  });

  it('undo of delete restores the task; redo trashes it again', async () => {
    await addTask({ ...baseInput, title: 'Round-trip' });
    const id = useStore.getState().currentTasks[0].id;

    await removeTask(id);
    expect(await liveTitles()).not.toContain('Round-trip');

    await undoLast(); // undo the delete
    expect(await liveTitles()).toContain('Round-trip');
    expect(useStore.getState().currentTasks.some((t) => t.id === id)).toBe(true);

    await redoLast(); // redo the delete
    expect(await liveTitles()).not.toContain('Round-trip');
    expect(await trashTitles()).toContain('Round-trip');
  });

  it('undo of add removes the task from live views (lands in Trash, restorable)', async () => {
    await addTask({ ...baseInput, title: 'Oops' });
    expect(await liveTitles()).toContain('Oops');

    await undoLast();
    expect(await liveTitles()).not.toContain('Oops');

    await redoLast();
    expect(await liveTitles()).toContain('Oops');
  });

  it('undo of edit restores the prior field values', async () => {
    await addTask({ ...baseInput, title: 'Original', importance: 2 });
    const id = useStore.getState().currentTasks[0].id;

    await editTask(id, { ...baseInput, title: 'Renamed', importance: 5 });
    expect(useStore.getState().currentTasks.find((t) => t.id === id)?.title).toBe('Renamed');

    await undoLast();
    const reverted = useStore.getState().currentTasks.find((t) => t.id === id)!;
    expect(reverted.title).toBe('Original');
    expect(reverted.importance).toBe(2);

    await redoLast();
    expect(useStore.getState().currentTasks.find((t) => t.id === id)?.title).toBe('Renamed');
  });

  it('manual restore pulls a task back out of Trash', async () => {
    await addTask({ ...baseInput, title: 'Manual' });
    const id = useStore.getState().currentTasks[0].id;
    await removeTask(id);

    await loadTrash();
    expect(useStore.getState().currentTasks.some((t) => t.id === id)).toBe(true);

    await restoreFromTrash(id);
    expect(await liveTitles()).toContain('Manual');
    expect(await trashTitles()).not.toContain('Manual');
  });

  it('empty Trash purges only soft-deleted rows', async () => {
    await addTask({ ...baseInput, title: 'Live one' });
    await addTask({ ...baseInput, title: 'Doomed' });
    const doomedId = useStore.getState().currentTasks.find((t) => t.title === 'Doomed')!.id;
    await removeTask(doomedId);

    const purged = await emptyTrash();
    expect(purged).toBe(1);
    expect(await trashTitles()).toEqual([]);
    expect(await liveTitles()).toContain('Live one');
  });

  it('keeps live views free of trashed tasks', async () => {
    await addTask({ ...baseInput, title: 'A' });
    await addTask({ ...baseInput, title: 'B' });
    const bId = useStore.getState().currentTasks.find((t) => t.title === 'B')!.id;
    await removeTask(bId);

    const live = await liveTitles();
    expect(live).toContain('A');
    expect(live).not.toContain('B');
  });
});
