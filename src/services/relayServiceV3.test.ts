import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./syncService', () => ({
  mergeIntoApp: vi.fn(async (ops) => ({ applied: await (await import('./oplogStore')).ingestOps(ops), upserts: 0, deletes: 0 })),
}));

import { _resetForTests as resetIdentity } from './identity';
import {
  enableSyncV3,
  disableSync,
  getConfig,
  getWorkspaceBinding,
  syncNow,
} from './relayService';
import { logTaskUpsert, _resetForTests } from './oplogStore';
import { projectTasks } from './projector';
import { loadOps } from '../db';
import type { Task } from '../store';
import { FakeBatchRelay as FakeRelay } from './fixtures/fakeBatchRelay';
import { encodeSetupCode } from './crypto';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
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
const PASS = 'correct horse battery staple';
const SETUP_RAW = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const SETUP_CODE = encodeSetupCode(SETUP_RAW); // '0410-6105-0R3G-G28A-1C60-T3GF-20E'

describe('relayService v3 — secure storage and workspace binding', () => {
  let A: MemStorage, B: MemStorage, relay: FakeRelay;

  beforeEach(() => {
    A = new MemStorage();
    B = new MemStorage();
    relay = new FakeRelay();
    (globalThis as any).fetch = vi.fn((url: string, init?: any) =>
      Promise.resolve(relay.handle(init?.method ?? 'GET', url, init?.body) as any)
    );
  });

  it('enableSyncV3 autogenerates setup code and delete token when not provided', async () => {
    (globalThis as any).localStorage = A;
    _resetForTests(); resetIdentity();

    const res = await enableSyncV3(RELAY, PASS);
    expect(res.setupCode).toMatch(/^[0-9A-HJKMNP-Z]{4}(-[0-9A-HJKMNP-Z]{4}){5}-[0-9A-HJKMNP-Z]{3}$/);
    expect(res.deleteToken).toMatch(/^[0-9a-f]{32}$/);
    expect(res.room).toMatch(/^[0-9a-f]{32}$/);

    const cfg = await getConfig();
    expect(cfg).not.toBeNull();
    expect(cfg?.version).toBe(3);
    expect(cfg?.url).toBe(RELAY);
    expect(cfg?.passphrase).toBe(PASS);
    expect(cfg?.setupCode).toBe(res.setupCode);
    expect(cfg?.deleteToken).toBe(res.deleteToken);

    const binding = await getWorkspaceBinding();
    expect(binding).not.toBeNull();
    expect(binding?.version).toBe(3);
    expect(binding?.room).toBe(res.room);
    expect(binding?.setup_code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('enableSyncV3 uses provided setup code and derives deterministic room R_v3', async () => {
    (globalThis as any).localStorage = A;
    _resetForTests(); resetIdentity();

    const res = await enableSyncV3(RELAY, PASS, SETUP_CODE);
    expect(res.setupCode).toBe(SETUP_CODE);
    // af340eac1d2451afe20f762a4a8cb695 from Section 3.3 KAT
    expect(res.room).toBe('af340eac1d2451afe20f762a4a8cb695');
  });

  it('rejects weak passphrase (< 12 chars) or invalid setup code', async () => {
    (globalThis as any).localStorage = A;
    _resetForTests(); resetIdentity();

    await expect(enableSyncV3(RELAY, 'short-pass', SETUP_CODE)).rejects.toThrow();
    await expect(enableSyncV3(RELAY, PASS, 'invalid-setup-code')).rejects.toThrow();
  });

  it('enforces workspace binding against mismatched credentials when ops exist', async () => {
    (globalThis as any).localStorage = A;
    _resetForTests(); resetIdentity();

    await enableSyncV3(RELAY, PASS, SETUP_CODE);
    await logTaskUpsert(task('t1', { title: 'First Task' }));

    // Reset session in-memory state while keeping database/localStorage
    _resetForTests(); resetIdentity();
    await disableSync();

    // Reconnecting with different setup code must be rejected by workspace binding
    const differentSetup = encodeSetupCode(new Uint8Array(16).fill(0xff));
    await expect(enableSyncV3(RELAY, PASS, differentSetup)).rejects.toThrow(/bound to its previous/i);

    // Reconnecting with correct credentials succeeds
    await expect(enableSyncV3(RELAY, PASS, SETUP_CODE)).resolves.toBeDefined();
  });

  it('disableSync clears all v3 credentials', async () => {
    (globalThis as any).localStorage = A;
    _resetForTests(); resetIdentity();

    await enableSyncV3(RELAY, PASS, SETUP_CODE);
    expect(await getConfig()).not.toBeNull();

    await disableSync();
    expect(await getConfig()).toBeNull();
  });

  it('converges tasks across two devices using v3 credentials', async () => {
    (globalThis as any).localStorage = A;
    _resetForTests(); resetIdentity();
    await enableSyncV3(RELAY, PASS, SETUP_CODE);
    await logTaskUpsert(task('t1', { title: 'v3 Device A task' }));
    await syncNow();

    // Device B joins with same v3 credentials
    (globalThis as any).localStorage = B;
    _resetForTests(); resetIdentity();
    await enableSyncV3(RELAY, PASS, SETUP_CODE);
    await syncNow();

    const onB = projectTasks(await loadOps());
    expect(onB.map((t) => t.id)).toEqual(['t1']);
    expect(onB[0].title).toBe('v3 Device A task');
  });
});
