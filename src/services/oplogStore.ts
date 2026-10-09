/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/oplogStore.ts — op-log persistence & recording (Act 2)
   ──────────────────────────────────────────────────────
   Owns this device's actor id and a single Hybrid Logical Clock, persists
   ops, and records mutations from the taskService choke point.

   Task/project row mutations record history in the database adapter's atomic
   command path. These helpers record collaboration/history-only operations;
   failed persistence propagates to callers. Legacy repair is explicit.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { appendOps, loadOps, getSetting, setSetting } from '../db';
import { Clock, entityToOps, setOp, delOp, materialize, hlcCompare, type Op, type Json, type EntityState } from './oplog';
import type { Task } from '../store';

let clock: Clock | null = null;
let ready: Promise<void> | null = null;

/** Stable per-install identity — the CRDT actor and total-order tiebreak. */
async function getActorId(): Promise<string> {
  let actor = await getSetting('crdt_actor', '');
  if (!actor) {
    actor = (crypto.randomUUID?.() ?? `actor-${Math.random().toString(36).slice(2)}`);
    await setSetting('crdt_actor', actor);
  }
  return actor;
}

/** Lazily build the clock, seeded past the newest op we've already seen. */
function init(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    const actor = await getActorId();
    const ops = await loadOps();
    const c = new Clock(actor, Date.now());
    const saved = await getSetting('crdt_hlc','');
    if (saved) {
      const hlc = JSON.parse(saved);
      if (!Number.isSafeInteger(hlc.wall) || !Number.isSafeInteger(hlc.counter) || hlc.wall<0 || hlc.counter<0 || hlc.actor!==actor) throw new Error('Invalid persisted operation clock.');
      c.receive(hlc);
    }
    // Fold the highest known timestamp in so our next tick is causally after it.
    let max: Op | null = null;
    for (const o of ops) if (!max || hlcCompare(o.hlc, max.hlc) > 0) max = o;
    if (max) c.receive(max.hlc, Date.now());
    clock = c;
  })().catch((e) => {
    ready = null;
    throw e;
  });
  return ready;
}

/** The fields we mirror into the op-log (everything that defines a task). */
export { TASK_FIELDS as TRACKED } from './taskFields';
import { taskRecord } from './taskFields';

async function refreshClock(): Promise<void> {
  await init();
  if (!clock) throw new Error('Operation clock unavailable.');
  for (const op of await loadOps()) if (hlcCompare(op.hlc,clock.current())>=0) clock.receive(op.hlc);
}

function taskFields(task: Task): Record<string, Json> {
  return taskRecord(task);
}

/** Record a task create/update as one `set` op per tracked field. */
export async function logTaskUpsert(task: Task): Promise<void> {
  try {
    await refreshClock();
    if (!clock || !task?.id) return;
    await appendOps(entityToOps(clock, task.id, taskFields(task)));
  } catch (e) {
    throw e;
  }
}

/** Soft-delete (Trash) is a field change, not a tombstone — the task survives. */
export async function logTaskSoftDelete(id: string, when: string): Promise<void> {
  try {
    await refreshClock();
    if (!clock || !id) return;
    await appendOps([setOp(clock, id, 'deleted_at', when)]);
  } catch (e) {
    throw e;
  }
}

/** Restore from Trash clears the soft-delete stamp. */
export async function logTaskRestore(id: string): Promise<void> {
  try {
    await refreshClock();
    if (!clock || !id) return;
    await appendOps([setOp(clock, id, 'deleted_at', null)]);
  } catch (e) {
    throw e;
  }
}

/**
 * Record an arbitrary collaboration op (Act 3) on the same clock as task ops,
 * so HLCs stay monotonic per actor. Used for roster (`member:`) and `comment:`
 * entities. Returns the op (for immediate signing/push), or null on failure.
 */
export async function logCollabSet(entity: string, field: string, value: Json): Promise<Op | null> {
  try {
    await refreshClock();
    if (!clock || !entity) return null;
    const op = setOp(clock, entity, field, value);
    await appendOps([op]);
    return op;
  } catch (e) {
    throw e;
  }
}

/** Commit collaboration fields together, optionally against a reviewed workspace. */
export async function logCollabBatch(fields:Array<{entity:string;field:string;value:Json}>, expected?:unknown):Promise<Op[]> {
  await refreshClock();
  if(!clock) throw new Error('Operation clock unavailable.');
  const ops=fields.map(f=>setOp(clock!,f.entity,f.field,f.value));
  await appendOps(ops,expected);
  return ops;
}

/** Tombstone a collaboration entity (e.g. remove a member). */
export async function logCollabDel(entity: string): Promise<Op | null> {
  try {
    await refreshClock();
    if (!clock || !entity) return null;
    const op = delOp(clock, entity);
    await appendOps([op]);
    return op;
  } catch (e) {
    throw e;
  }
}

/** Permanent deletion (purge / empty Trash) is a CRDT tombstone. */
export async function logTaskDelete(id: string): Promise<void> {
  try {
    await refreshClock();
    if (!clock || !id) return;
    await appendOps([delOp(clock, id)]);
  } catch (e) {
    throw e;
  }
}

/**
 * One-time backfill: seed the op-log from tasks that predate it (or arrived
 * via a non-logged path), so the log fully represents current state before we
 * ever project from it. Only writes ops for entities the log doesn't know yet.
 */
export async function backfillFromTasks(tasks: Task[]): Promise<number> {
  try {
    await refreshClock();
    if (!clock) return 0;
    const known = new Set<string>();
    for (const o of await loadOps()) known.add(o.entity);
    let n = 0;
    for (const t of tasks) {
      if (t?.id && !known.has(t.id)) { await logTaskUpsert(t); n++; }
    }
    return n;
  } catch (e) {
    console.warn('[oplog] backfill failed:', e);
    return 0;
  }
}

/**
 * Ingest ops from another device/bundle: persist them (deduped) and advance
 * our clock past the newest, so subsequent local edits are causally after the
 * remote history. The merge itself is conflict-free (see oplog.ts).
 */
export async function ingestOps(ops: Op[]): Promise<number> {
  await init();
  if (!clock) throw new Error('Operation clock unavailable.');
  if (!ops?.length) return 0;
  await appendOps(ops);
  let max: Op | null = null;
  for (const o of ops) if (!max || hlcCompare(o.hlc, max.hlc) > 0) max = o;
  if (max) clock.receive(max.hlc, Date.now());
  return ops.length;
}

/** Advance the in-memory clock after a transaction already persisted ops. */
export async function observeOps(ops: Op[]): Promise<void> {
  await init();
  if (!clock) throw new Error('Operation clock unavailable.');
  for (const op of ops) if (hlcCompare(op.hlc, clock.current()) >= 0) clock.receive(op.hlc);
}

/** Project the persisted op-log to current entity state (the future read path). */
export async function projectEntities(): Promise<Map<string, EntityState>> {
  return materialize(await loadOps());
}

/** This device's CRDT actor id (stable per install). */
export async function actorId(): Promise<string> {
  await init();
  return clock ? clock.actor : '';
}

/** Reset module state — test seam only. */
export function _resetForTests(): void {
  clock = null;
  ready = null;
}

/** Record an owner-authorized checkpoint as one durable operation batch. */
export async function logCollabCheckpoint(states:Map<string,EntityState>,deleted:string[]=[]):Promise<void> {
  await refreshClock();
  if(!clock) throw new Error('Operation clock unavailable.');
  const ops:Op[]=[];
  for(const [entity,state] of states) for(const [field,value] of Object.entries(state)) ops.push(setOp(clock,entity,field,value));
  for(const entity of deleted) ops.push(delOp(clock,entity));
  await appendOps(ops);
}
