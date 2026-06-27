import { describe, it, expect } from 'vitest';
import {
  Clock,
  setOp,
  delOp,
  entityToOps,
  merge,
  materialize,
  converged,
  hlcCompare,
  type Op,
} from './oplog';

// Deterministic shuffle so failures reproduce.
function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('HLC', () => {
  it('advances monotonically even when the wall clock stalls or rewinds', () => {
    const c = new Clock('A', 1000);
    const t1 = c.tick(1000);
    const t2 = c.tick(1000);        // same wall → counter bumps
    const t3 = c.tick(999);         // clock went backwards → still advances
    expect(hlcCompare(t1, t2)).toBeLessThan(0);
    expect(hlcCompare(t2, t3)).toBeLessThan(0);
  });

  it('receive() makes the next local tick causally after a remote event', () => {
    const c = new Clock('A', 0);
    c.receive({ wall: 5000, counter: 9, actor: 'B' }, 0);
    const next = c.tick(0);
    expect(hlcCompare({ wall: 5000, counter: 9, actor: 'B' }, next)).toBeLessThan(0);
  });
});

describe('materialize (LWW element map)', () => {
  it('resolves each field to its highest-HLC write', () => {
    const a = new Clock('A', 0);
    const b = new Clock('B', 0);
    const o1 = setOp(a, 't1', 'title', 'first', 100);
    const o2 = setOp(b, 't1', 'title', 'second', 200); // later wall → wins
    const state = materialize([o1, o2]).get('t1');
    expect(state?.title).toBe('second');
  });

  it('breaks a wall+counter tie deterministically by actor id', () => {
    // Two devices write the same field at the same instant; higher actor wins.
    const lo: Op = { id: 'x', hlc: { wall: 1, counter: 0, actor: 'A' }, kind: 'set', entity: 't', field: 'f', value: 'A-wins?' };
    const hi: Op = { id: 'y', hlc: { wall: 1, counter: 0, actor: 'B' }, kind: 'set', entity: 't', field: 'f', value: 'B-wins' };
    expect(materialize([lo, hi]).get('t')?.f).toBe('B-wins');
    expect(materialize([hi, lo]).get('t')?.f).toBe('B-wins'); // order-independent
  });

  it('a delete hides the entity; a later write revives it', () => {
    const c = new Clock('A', 0);
    const create = entityToOps(c, 't', { title: 'task', done: false }, 100);
    const del = delOp(c, 't', 200);
    expect(materialize([...create, del]).has('t')).toBe(false);

    const revive = setOp(c, 't', 'title', 'back', 300);
    const after = materialize([...create, del, revive]).get('t');
    expect(after).toEqual({ title: 'back' }); // only post-tombstone fields survive
  });
});

describe('CRDT properties (the sync guarantees)', () => {
  // A realistic concurrent history across two devices.
  function history(): Op[] {
    const a = new Clock('A', 0);
    const b = new Clock('B', 0);
    return [
      ...entityToOps(a, 't1', { title: 'Write spec', done: false, priority: 'high' }, 10),
      ...entityToOps(b, 't2', { title: 'Review PR', done: false, priority: 'low' }, 12),
      setOp(a, 't1', 'done', true, 30),
      setOp(b, 't1', 'priority', 'medium', 25),   // concurrent edit to t1 from B
      setOp(a, 't2', 'title', 'Review PR carefully', 40),
      delOp(b, 't2', 35),                          // B deletes t2 before A's rename — rename (later) revives
    ];
  }

  it('is order-independent: any permutation converges to the same state', () => {
    const base = history();
    const reference = materialize(base);
    for (let seed = 1; seed <= 50; seed++) {
      const permuted = materialize(shuffle(base, seed));
      expect(permuted.size).toBe(reference.size);
      for (const [id, state] of reference) expect(permuted.get(id)).toEqual(state);
    }
  });

  it('merge is commutative, associative, and idempotent', () => {
    const all = history();
    const x = all.slice(0, 4);
    const y = all.slice(2, 6); // deliberately overlapping logs
    const z = all.slice(4);

    expect(converged(merge(x, y), merge(y, x))).toBe(true);                 // commutative
    expect(converged(merge(merge(x, y), z), merge(x, merge(y, z)))).toBe(true); // associative
    expect(converged(merge(x, x), x)).toBe(true);                           // idempotent
    expect(converged(merge(x, y, z), all)).toBe(true);                      // full union == original
  });

  it('two devices syncing in either direction reach an identical projection', () => {
    const all = history();
    const deviceA = all.filter((_, i) => i % 2 === 0);
    const deviceB = all.filter((_, i) => i % 2 === 1);
    // Each device merges the other's log; both must agree.
    const aAfter = merge(deviceA, deviceB);
    const bAfter = merge(deviceB, deviceA);
    expect(converged(aAfter, bAfter)).toBe(true);
    // …and agree with the canonical full history.
    expect(converged(aAfter, all)).toBe(true);
  });
});
