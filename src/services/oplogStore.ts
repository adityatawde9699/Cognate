/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/oplogStore.ts — op-log persistence & recording (Act 2)
   ──────────────────────────────────────────────────────
   Owns this device's actor id and a single Hybrid Logical Clock, persists
   ops, and records mutations from the taskService choke point.

   SHADOW MODE: today this runs alongside the SQLite-as-truth pipeline so we
   can prove the op-log converges and projects correctly before cutting reads
   over to it (the next Act 2 slice). Recording is best-effort and must never
   affect the user-facing path — every entry point swallows its own errors.
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
    // Fold the highest known timestamp in so our next tick is causally after it.
    let max: Op | null = null;
    for (const o of ops) if (!max || hlcCompare(o.hlc, max.hlc) > 0) max = o;
    if (max) c.receive(max.hlc, Date.now());
    clock = c;
  })().catch((e) => {
    console.warn('[oplog] init failed:', e);
  });
  return ready;
}

/** The fields we mirror into the op-log (everything that defines a task). */
export const TRACKED: (keyof Task)[] = [
  'title', 'description', 'deadline', 'tags', 'importance', 'effort', 'priority',
  'done', 'created_at', 'completed_at', 'pomodoros_spent', 'project_id', 'parent_id',
  'milestone_id', 'recurrence', 'sort_order', 'custom_fields', 'deleted_at',
  'duration_min', 'energy', 'pinned', 'scheduled_start', 'scheduled_end',
];

function taskFields(task: Task): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of TRACKED) {
    const v = (task as any)[k];
    if (v !== undefined) out[k as string] = v as Json;
  }
  return out;
}

/** Record a task create/update as one `set` op per tracked field. */
export async function logTaskUpsert(task: Task): Promise<void> {
  try {
    await init();
    if (!clock || !task?.id) return;
    await appendOps(entityToOps(clock, task.id, taskFields(task)));
  } catch (e) {
    console.warn('[oplog] logTaskUpsert failed:', e);
  }
}

/** Soft-delete (Trash) is a field change, not a tombstone — the task survives. */
export async function logTaskSoftDelete(id: string, when: string): Promise<void> {
  try {
    await init();
    if (!clock || !id) return;
    await appendOps([setOp(clock, id, 'deleted_at', when)]);
  } catch (e) {
    console.warn('[oplog] logTaskSoftDelete failed:', e);
  }
}

/** Restore from Trash clears the soft-delete stamp. */
export async function logTaskRestore(id: string): Promise<void> {
  try {
    await init();
    if (!clock || !id) return;
    await appendOps([setOp(clock, id, 'deleted_at', null)]);
  } catch (e) {
    console.warn('[oplog] logTaskRestore failed:', e);
  }
}

/**
 * Record an arbitrary collaboration op (Act 3) on the same clock as task ops,
 * so HLCs stay monotonic per actor. Used for roster (`member:`) and `comment:`
 * entities. Returns the op (for immediate signing/push), or null on failure.
 */
export async function logCollabSet(entity: string, field: string, value: Json): Promise<Op | null> {
  try {
    await init();
    if (!clock || !entity) return null;
    const op = setOp(clock, entity, field, value);
    await appendOps([op]);
    return op;
  } catch (e) {
    console.warn('[oplog] logCollabSet failed:', e);
    return null;
  }
}

/** Tombstone a collaboration entity (e.g. remove a member). */
export async function logCollabDel(entity: string): Promise<Op | null> {
  try {
    await init();
    if (!clock || !entity) return null;
    const op = delOp(clock, entity);
    await appendOps([op]);
    return op;
  } catch (e) {
    console.warn('[oplog] logCollabDel failed:', e);
    return null;
  }
}

/** Permanent deletion (purge / empty Trash) is a CRDT tombstone. */
export async function logTaskDelete(id: string): Promise<void> {
  try {
    await init();
    if (!clock || !id) return;
    await appendOps([delOp(clock, id)]);
  } catch (e) {
    console.warn('[oplog] logTaskDelete failed:', e);
  }
}

/**
 * One-time backfill: seed the op-log from tasks that predate it (or arrived
 * via a non-logged path), so the log fully represents current state before we
 * ever project from it. Only writes ops for entities the log doesn't know yet.
 */
export async function backfillFromTasks(tasks: Task[]): Promise<number> {
  try {
    await init();
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
  try {
    await init();
    if (!clock || !ops?.length) return 0;
    await appendOps(ops);
    let max: Op | null = null;
    for (const o of ops) if (!max || hlcCompare(o.hlc, max.hlc) > 0) max = o;
    if (max) clock.receive(max.hlc, Date.now());
    return ops.length;
  } catch (e) {
    console.warn('[oplog] ingestOps failed:', e);
    return 0;
  }
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
