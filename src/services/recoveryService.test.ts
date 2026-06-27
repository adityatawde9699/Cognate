import { describe, it, expect, beforeEach } from 'vitest';
import { exportRecoveryKit, importRecoveryKit } from './recoveryService';
import { createShare, listShares, getShare } from './shareService';
import { enableSync } from './relayService';
import { logTaskUpsert, _resetForTests as resetOplog } from './oplogStore';
import { _resetForTests as resetIdentity } from './identity';
import type { Task } from '../store';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, description: '', deadline: '', tags: [], importance: 3, effort: 3, done: false,
  created_at: '2026-01-01', completed_at: null, pomodoros_spent: 0, priority: 'medium', sort_order: 0,
  project_id: null, parent_id: null, recurrence: 'none', milestone_id: null, custom_fields: {},
  deleted_at: null, energy: 'med', pinned: false, ...over,
});

async function as<T>(store: MemStorage, fn: () => Promise<T>): Promise<T> {
  (globalThis as any).localStorage = store;
  resetOplog();
  resetIdentity();
  return fn();
}

describe('recoveryService — encrypted key escrow', () => {
  let A: MemStorage, B: MemStorage;
  beforeEach(() => { A = new MemStorage(); B = new MemStorage(); });

  it('exports an encrypted kit that restores shares on a new device', async () => {
    let kit = '';
    await as(A, async () => {
      await enableSync('https://relay.example', 'team-pass');
      await logTaskUpsert(task('t1', { project_id: 'p1' }));
      await createShare('p1', 'Alpha', 'https://relay.example');
      kit = await exportRecoveryKit('my-recovery-pass');
    });

    // The kit is ciphertext — it must not leak a share secret or relay pass.
    expect(kit).toContain('"ct"');
    expect(kit).not.toContain('team-pass');
    expect(kit).not.toContain('Alpha');

    // Fresh device: nothing yet, then restore.
    await as(B, async () => {
      expect(await listShares()).toHaveLength(0);
      const res = await importRecoveryKit(kit, 'my-recovery-pass');
      expect(res.shares).toBe(1);
      expect(res.relay).toBe(true);

      const shares = await listShares();
      expect(shares[0].name).toBe('Alpha');
      const full = await getShare(shares[0].id);
      expect(full?.secret).toBeTruthy(); // the capability came back
    });
  });

  it('refuses to restore with the wrong passphrase', async () => {
    let kit = '';
    await as(A, async () => {
      await logTaskUpsert(task('t1', { project_id: 'p1' }));
      await createShare('p1', 'Alpha', 'https://relay.example');
      kit = await exportRecoveryKit('correct-pass');
    });
    await as(B, async () => {
      await expect(importRecoveryKit(kit, 'wrong-pass')).rejects.toThrow();
      expect(await listShares()).toHaveLength(0);
    });
  });
});
