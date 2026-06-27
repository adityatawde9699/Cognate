import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep the DB reconcile out of this unit — we're proving the relay round-trip
// (seal → store → fetch → open → merge), which is separately reconciled.
vi.mock('./syncService', () => ({
  reconcileIntoApp: vi.fn(async () => ({ upserts: 0, deletes: 0 })),
}));

import { enableSync, syncNow } from './relayService';
import { logTaskUpsert, _resetForTests } from './oplogStore';
import { projectTasks } from './projector';
import { loadOps } from '../db';
import type { Task } from '../store';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// An in-memory stand-in for the Rust relay, mirroring its contract exactly.
class FakeRelay {
  rooms = new Map<string, Map<string, any>>();
  handle(method: string, url: string, body?: string) {
    const path = new URL(url).pathname.split('/').filter(Boolean); // [rooms, room, blobs, actor?]
    const room = path[1];
    if (method === 'PUT' && path[3]) {
      if (!this.rooms.has(room)) this.rooms.set(room, new Map());
      this.rooms.get(room)!.set(path[3], JSON.parse(body!));
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    if (method === 'GET' && path[2] === 'blobs') {
      const blobs = [...(this.rooms.get(room) ?? new Map()).entries()].map(([actor, b]) => ({ actor, ...b }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ blobs }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  }
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, description: '', deadline: '', tags: [], importance: 3, effort: 3,
    done: false, created_at: '2026-01-01', completed_at: null, pomodoros_spent: 0, priority: 'medium',
    sort_order: 0, project_id: null, parent_id: null, recurrence: 'none', milestone_id: null,
    custom_fields: {}, deleted_at: null, energy: 'med', pinned: false, ...over,
  };
}

const RELAY = 'https://relay.example';
const PASS = 'shared-team-passphrase-9000';

async function on<T>(store: MemStorage, fn: () => Promise<T>): Promise<T> {
  (globalThis as any).localStorage = store;
  _resetForTests();
  await enableSync(RELAY, PASS); // same passphrase ⇒ same key + room on every device
  return fn();
}

describe('relayService — live sync over a dumb E2E relay', () => {
  let A: MemStorage, B: MemStorage, relay: FakeRelay;

  beforeEach(() => {
    A = new MemStorage();
    B = new MemStorage();
    relay = new FakeRelay();
    (globalThis as any).fetch = vi.fn((url: string, init?: any) =>
      Promise.resolve(relay.handle(init?.method ?? 'GET', url, init?.body) as any)
    );
  });

  it('only ever stores ciphertext on the relay (never plaintext)', async () => {
    await on(A, async () => {
      await logTaskUpsert(task('t1', { title: 'TOPSECRETTASK' }));
      await syncNow();
    });
    const dump = JSON.stringify([...relay.rooms.values()].map((m) => [...m.values()]));
    expect(dump).not.toContain('TOPSECRETTASK');
    expect(dump).toContain('"ct"'); // sealed blobs, not task fields
  });

  it('a task created on device A converges onto device B after sync', async () => {
    await on(A, async () => {
      await logTaskUpsert(task('t1', { title: 'A: write spec' }));
      await syncNow();
    });
    await on(B, async () => {
      await logTaskUpsert(task('t2', { title: 'B: review' }));
      await syncNow(); // pushes B, pulls A
    });

    const onB = await on(B, async () => projectTasks(await loadOps()));
    const ids = onB.map((t) => t.id).sort();
    expect(ids).toEqual(['t1', 't2']);
    expect(onB.find((t) => t.id === 't1')?.title).toBe('A: write spec');

    // And after one more round, A also has both.
    await on(A, async () => { await syncNow(); });
    const onA = await on(A, async () => projectTasks(await loadOps()));
    expect(onA.map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('a device with the wrong passphrase cannot read the blobs', async () => {
    await on(A, async () => {
      await logTaskUpsert(task('t1', { title: 'A secret' }));
      await syncNow();
    });
    // Device C joins the same relay but with a different passphrase → different
    // room AND key, so it sees nothing and certainly can't decrypt.
    const C = new MemStorage();
    (globalThis as any).localStorage = C;
    _resetForTests();
    await enableSync(RELAY, 'a-totally-different-passphrase');
    await syncNow();
    const onC = projectTasks(await loadOps());
    expect(onC.find((t) => t.id === 't1')).toBeUndefined();
  });
});
