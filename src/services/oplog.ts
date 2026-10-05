/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/oplog.ts — The CRDT op-log (Act 2: The Sync Spine)
   ──────────────────────────────────────────────────────
   The de-risking spike for sync. Every mutation becomes an immutable,
   causally-ordered operation. The op-log is the *source of truth*; a
   materialized view (and, later, SQLite) is a pure projection of it.

   The CRDT is a Last-Writer-Wins element map:
     • each entity (a task) is a map of field → {value, hlc}
     • a delete records a tombstone hlc; a later write revives the entity
     • conflicts resolve by Hybrid Logical Clock, so applying the same set
       of ops in ANY order — on ANY device — yields the SAME state.

   This file is pure and platform-agnostic (no DB, no React): it is the
   thing we must get provably right before wiring a relay or mobile client.
   See oplog.test.ts for the convergence / commutativity property tests.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** A Hybrid Logical Clock timestamp: physical time + a tiebreak counter + actor. */
export interface HLC {
  wall: number;    // ms since epoch (physical clock, monotonic-guarded)
  counter: number; // disambiguates events within the same wall ms
  actor: string;   // unique per device/install — the final, total-order tiebreak
}

export type Op =
  | { id: string; hlc: HLC; kind: 'set'; entity: string; field: string; value: Json }
  | { id: string; hlc: HLC; kind: 'del'; entity: string };

// ── Hybrid Logical Clock ─────────────────────────────────

export function hlcCompare(a: HLC, b: HLC): number {
  if (a.wall !== b.wall) return a.wall - b.wall;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0;
}
export const hlcEqual = (a: HLC, b: HLC): boolean => hlcCompare(a, b) === 0;

/**
 * A clock advances on every local event and on receipt of a remote HLC,
 * never moving backwards — the guarantee that makes causal order hold even
 * when device wall-clocks disagree.
 */
export class Clock {
  private last: HLC;
  constructor(public readonly actor: string, now = 0) {
    this.last = { wall: now, counter: 0, actor };
  }

  /** Stamp a new local event. */
  tick(now: number = Date.now()): HLC {
    const wall = Math.max(this.last.wall, now);
    const counter = wall === this.last.wall ? this.last.counter + 1 : 0;
    if (!Number.isSafeInteger(wall) || wall<0 || !Number.isSafeInteger(counter)) throw new Error('Operation clock exhausted or invalid.');
    this.last = { wall, counter, actor: this.actor };
    return {...this.last};
  }

  /** Fold in a remote timestamp so our next tick is causally after it. */
  receive(remote: HLC, now: number = Date.now()): void {
    const wall = Math.max(this.last.wall, remote.wall, now);
    let counter: number;
    if (wall === this.last.wall && wall === remote.wall) counter = Math.max(this.last.counter, remote.counter) + 1;
    else if (wall === this.last.wall) counter = this.last.counter + 1;
    else if (wall === remote.wall) counter = remote.counter + 1;
    else counter = 0;
    if (!Number.isSafeInteger(wall) || wall<0 || !Number.isSafeInteger(counter)) throw new Error('Operation clock exhausted or invalid.');
    this.last = { wall, counter, actor: this.actor };
  }

  current(): HLC {
    return {...this.last};
  }
}

// ── Op construction ──────────────────────────────────────

/** Logical operation identity; merge rejects divergent contents with the same ID. */
function opId(hlc: HLC, kind: string, entity: string, field?: string): string {
  return `${hlc.wall}.${hlc.counter}.${hlc.actor}|${kind}|${entity}|${field ?? ''}`;
}

export function setOp(clock: Clock, entity: string, field: string, value: Json, now?: number): Op {
  const hlc = clock.tick(now);
  return { id: opId(hlc, 'set', entity, field), hlc, kind: 'set', entity, field, value };
}

export function delOp(clock: Clock, entity: string, now?: number): Op {
  const hlc = clock.tick(now);
  return { id: opId(hlc, 'del', entity), hlc, kind: 'del', entity };
}

/** Build one `set` op per field of a record — how a created/edited entity is logged. */
export function entityToOps(clock: Clock, entity: string, fields: Record<string, Json>, now?: number): Op[] {
  return Object.entries(fields).map(([field, value]) => setOp(clock, entity, field, value, now));
}

// ── Merge & materialize (the projection) ─────────────────

/**
 * Merge op-logs into one, de-duplicated by op id. Commutative, associative,
 * and idempotent — the algebraic properties a CRDT relay relies on.
 */
/** Stable encoding for comparisons and audit fingerprints (object key order is irrelevant). */
export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
function validJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => validJson(item, depth + 1));
  return typeof value === 'object' && !!value &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.entries(value).every(([key, item]) => !FORBIDDEN.has(key) && validJson(item, depth + 1));
}
function token(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

/** Reject an entire malformed batch; never silently drop records as synced. */
export function validateOps(input: unknown): asserts input is Op[] {
  if (!Array.isArray(input) || input.length > 50_000) throw new Error('Invalid or oversized operation batch.');
  for (const value of input) {
    const o = value as Partial<Op> & { version?: unknown };
    if (!o || (o.version !== undefined && o.version !== 1) || !token(o.id, 4096) || !token(o.entity, 512) ||
        !o.hlc || !token(o.hlc.actor, 512) ||
        !Number.isSafeInteger(o.hlc.wall) || o.hlc.wall < 0 ||
        !Number.isSafeInteger(o.hlc.counter) || o.hlc.counter < 0 ||
        (o.kind !== 'set' && o.kind !== 'del')) throw new Error('Malformed or unsupported operation.');
    if (o.kind === 'set' && (!token(o.field, 128) || FORBIDDEN.has(o.field) || !validJson(o.value))) {
      throw new Error('Invalid operation field or JSON value.');
    }
    if (JSON.stringify(o).length > 65_536) throw new Error('Operation exceeds size limit.');
  }
}

function opContent(op: Op): string {
  return canonicalJson(op.kind === 'set'
    ? { id: op.id, hlc: { ...op.hlc }, kind: op.kind, entity: op.entity, field: op.field, value: op.value }
    : { id: op.id, hlc: { ...op.hlc }, kind: op.kind, entity: op.entity });
}

export function merge(...logs: Op[][]): Op[] {
  const byId = new Map<string, Op>();
  const contents = new Map<string, string>();
  const writes = new Map<string, string>();
  for (const log of logs) {
    validateOps(log);
    for (const op of log) {
      const content = opContent(op);
      if (contents.has(op.id) && contents.get(op.id) !== content) throw new Error(`Operation ID collision: ${op.id}`);
      if (op.kind === 'set') {
        const stamp = JSON.stringify([op.entity, op.field, op.hlc.wall, op.hlc.counter, op.hlc.actor]);
        const value = canonicalJson(op.value);
        if (writes.has(stamp) && writes.get(stamp) !== value) throw new Error('Conflicting writes reuse an operation timestamp.');
        writes.set(stamp, value);
      }
      contents.set(op.id, content);
      if (!byId.has(op.id)) byId.set(op.id, op);
    }
  }
  return [...byId.values()].sort((a, b) => hlcCompare(a.hlc, b.hlc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type EntityState = Record<string, Json>;

/**
 * Fold an op-log down to current entity state. Pure and order-independent:
 * every field resolves to its highest-HLC write, and an entity is present
 * only if its newest write is newer than its newest delete (delete hides
 * earlier fields; a later write revives it).
 */
export function materialize(ops: Op[]): Map<string, EntityState> {
  // Per entity: newest write per field, and the newest delete hlc.
  const writes = new Map<string, Map<string, { value: Json; hlc: HLC }>>();
  const deletes = new Map<string, HLC>();

  for (const op of merge(ops)) {
    if (op.kind === 'set') {
      let fields = writes.get(op.entity);
      if (!fields) writes.set(op.entity, (fields = new Map()));
      const prev = fields.get(op.field);
      if (!prev || hlcCompare(op.hlc, prev.hlc) > 0) fields.set(op.field, { value: op.value, hlc: op.hlc });
    } else {
      const prev = deletes.get(op.entity);
      if (!prev || hlcCompare(op.hlc, prev) > 0) deletes.set(op.entity, op.hlc);
    }
  }

  const out = new Map<string, EntityState>();
  for (const [entity, fields] of writes) {
    const del = deletes.get(entity) ?? null;
    const state: EntityState = {};
    for (const [field, { value, hlc }] of fields) {
      if (del === null || hlcCompare(hlc, del) > 0) state[field] = value; // survives the tombstone
    }
    if (Object.keys(state).length > 0) out.set(entity, state);
  }
  return out;
}

/** True when two logs project to byte-identical state (used in tests & sync checks). */
export function converged(a: Op[], b: Op[]): boolean {
  const ma = materialize(a);
  const mb = materialize(b);
  if (ma.size !== mb.size) return false;
  for (const [k, va] of ma) {
    const vb = mb.get(k);
    if (!vb || canonicalJson(va) !== canonicalJson(vb)) return false;
  }
  return true;
}
