import { describe, it, expect, beforeEach } from 'vitest';
import { getIdentity, publicIdentity, signLocalOps, _resetForTests as resetIdentity } from './identity';
import { logTaskUpsert, _resetForTests as resetOplog } from './oplogStore';
import { verifySignedOps, authorize } from './collab';
import { loadOps } from '../db';
import type { Task } from '../store';

// In-memory localStorage so db.js's browser fallback (and the secrets fallback)
// work under node — secrets persist here exactly as they would in the keychain.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, description: '', deadline: '', tags: [],
    importance: 3, effort: 3, priority: 'medium', done: false, sort_order: 0,
    ...over,
  } as Task;
}

describe('identity — device signing identity', () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemStorage();
    resetIdentity();
    resetOplog();
  });

  it('mints a keypair on first use and persists it (stable across reloads)', async () => {
    const first = await publicIdentity();
    expect(first.actor).toBeTruthy();
    expect(first.pub).toMatch(/.+/);

    // Simulate a restart: drop the in-memory cache but keep the storage.
    resetIdentity();
    resetOplog();
    const second = await publicIdentity();
    expect(second.actor).toBe(first.actor); // same CRDT actor
    expect(second.pub).toBe(first.pub);     // same public key (reloaded, not regenerated)
  });

  it('binds the signing identity to the CRDT actor id', async () => {
    const id = await getIdentity();
    await logTaskUpsert(task('t1'));
    const ops = await loadOps();
    expect(ops.length).toBeGreaterThan(0);
    // Every op this device authored carries our actor in its HLC.
    for (const op of ops) expect(op.hlc.actor).toBe(id.actor);
  });

  it('signs ops that verify against our published public key', async () => {
    const id = await getIdentity();
    await logTaskUpsert(task('t1', { title: 'signed work' }));
    const signed = await signLocalOps(await loadOps());

    const verified = await verifySignedOps(signed);
    expect(verified).toHaveLength(signed.length);
    for (const v of verified) expect(v.pub).toBe(id.pub);
  });

  it('round-trips the choke point → sign → authorize as owner of your own data', async () => {
    // Ops recorded through the normal mutation path...
    await logTaskUpsert(task('t1', { title: 'mine' }));
    await logTaskUpsert(task('t2', { title: 'also mine' }));

    // ...signed by our identity, are all admitted when WE are the genesis owner.
    const me = await publicIdentity();
    const signed = await signLocalOps(await loadOps());
    const res = await authorize(signed, { actor: me.actor, pub: me.pub });

    expect(res.rejected).toHaveLength(0);
    expect(res.admitted.length).toBe(signed.length);
    expect(res.roster.get(me.actor)?.role).toBe('owner');
  });

  it('a different device’s identity is rejected against our owner genesis', async () => {
    // Our doc, our genesis owner.
    const me = await publicIdentity();

    // A second device with its own storage + identity authors an op.
    (globalThis as any).localStorage = new MemStorage();
    resetIdentity();
    resetOplog();
    await logTaskUpsert(task('t1', { title: 'intruder' }));
    const otherSigned = await signLocalOps(await loadOps());

    // Their signed ops are valid signatures, but not from a roster member.
    const res = await authorize(otherSigned, { actor: me.actor, pub: me.pub });
    expect(res.admitted).toHaveLength(0);
    expect(res.rejected.length).toBe(otherSigned.length);
  });
});
