import { describe, it, expect, beforeEach } from 'vitest';
import { getIdentity, publicIdentity, signLocalOps, replaceDeviceIdentity, _resetForTests as resetIdentity } from './identity';
import { logTaskUpsert, _resetForTests as resetOplog } from './oplogStore';
import { verifySignedOps, authorize } from './collab';
import { loadOps, setSetting, getSetting } from '../db';
import { materialize } from './oplog';
import { setSecret } from '../utils/secrets';
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

describe('identity recovery guards', () => {
  beforeEach(() => { (globalThis as any).localStorage = new MemStorage(); resetIdentity(); resetOplog(); });
  it('refuses a published key without the private key', async () => {
    await setSetting('crdt_signing_pub','orphan-public-key');
    await expect(getIdentity()).rejects.toThrow('incomplete');
  });
  it('rejects mismatched keys instead of replacing registered identity', async () => {
    await getIdentity();
    const {generateSigningKeypair,exportPublicKey} = await import('./crypto');
    const different = await generateSigningKeypair();
    await setSetting('crdt_signing_pub',await exportPublicKey(different.publicKey));
    resetIdentity();
    await expect(getIdentity()).rejects.toThrow('do not match');
  });
  it('rejects actor rebinding', async () => {
    await getIdentity();
    await setSetting('crdt_actor','replacement');
    resetIdentity(); resetOplog();
    await expect(getIdentity()).rejects.toThrow('binding changed');
  });

  it('replaces a lost key with a fresh actor and re-logs that device\'s data', async () => {
    const before = await getIdentity();
    await logTaskUpsert(task('t1', { title: 'kept' }));
    await setSecret('crdt_signing_key', ''); // keychain wiped
    resetIdentity();
    await expect(getIdentity()).rejects.toThrow(/replace this device/);

    const result = await replaceDeviceIdentity();
    expect(result.previous).toBe(before.actor);
    expect(result.actor).not.toBe(before.actor);
    expect(result.relogged).toBe(1);
    const after = await getIdentity();
    expect(after.actor).toBe(result.actor);
    expect(after.pub).not.toBe(before.pub);

    const ops = await loadOps();
    const reauthored = ops.filter(op => op.hlc.actor === after.actor && op.entity === 't1');
    expect(reauthored.length).toBeGreaterThan(0);
    const oldMax = Math.max(...ops.filter(op => op.hlc.actor === before.actor).map(op => op.hlc.wall * 1e6 + op.hlc.counter));
    expect(Math.min(...reauthored.map(op => op.hlc.wall * 1e6 + op.hlc.counter))).toBeGreaterThan(oldMax);
    expect(materialize(ops).get('t1')?.title).toBe('kept');
    expect(JSON.parse(await getSetting('identity_replaced_from', '{}')).actor).toBe(before.actor);

    // Survives a restart, and new ops sign with the new key.
    resetIdentity(); resetOplog();
    expect((await getIdentity()).actor).toBe(result.actor);
    const signed = await signLocalOps(reauthored);
    expect(signed.every(op => op.pub === after.pub)).toBe(true);
  });
});
