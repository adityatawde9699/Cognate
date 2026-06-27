/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/projector.ts — op-log → Task projection (Act 2)
   ──────────────────────────────────────────────────────
   The "SQLite is a projection of the op-log" half of the sync spine, in pure
   form: fold the CRDT op-log into Task records, and diff a projection against
   the current materialized state so a reconciler can write only what changed.
   No DB, no store, no React — just data → data, so it is exhaustively testable.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { materialize, type Op, type EntityState } from './oplog';
import type { Task } from '../store';

/** Fields whose value the op-log carries verbatim and the projection restores. */
const PROJECTED_KEYS = [
  'title', 'description', 'tags', 'deadline', 'importance', 'effort', 'done',
  'created_at', 'completed_at', 'pomodoros_spent', 'priority', 'sort_order',
  'project_id', 'parent_id', 'recurrence', 'milestone_id', 'custom_fields',
  'deleted_at', 'duration_min', 'scheduled_start', 'scheduled_end', 'energy', 'pinned',
] as const;

/** Rebuild a full Task from its projected field map, filling sane defaults. */
export function entityStateToTask(id: string, s: EntityState): Task {
  return {
    id,
    title: (s.title as string) ?? '',
    description: (s.description as string) ?? '',
    tags: (s.tags as string[]) ?? [],
    deadline: (s.deadline as string) ?? '',
    importance: (s.importance as number) ?? 3,
    effort: (s.effort as number) ?? 3,
    done: (s.done as boolean) ?? false,
    created_at: (s.created_at as string) ?? '',
    completed_at: (s.completed_at as string | null) ?? null,
    pomodoros_spent: (s.pomodoros_spent as number) ?? 0,
    priority: (s.priority as Task['priority']) ?? 'medium',
    sort_order: (s.sort_order as number) ?? 0,
    project_id: (s.project_id as string | null) ?? null,
    parent_id: (s.parent_id as string | null) ?? null,
    recurrence: (s.recurrence as Task['recurrence']) ?? 'none',
    milestone_id: (s.milestone_id as string | null) ?? null,
    custom_fields: (s.custom_fields as Record<string, string>) ?? {},
    deleted_at: (s.deleted_at as string | null) ?? null,
    duration_min: (s.duration_min as number) ?? 0,
    scheduled_start: (s.scheduled_start as string | null) ?? null,
    scheduled_end: (s.scheduled_end as string | null) ?? null,
    energy: (s.energy as Task['energy']) ?? 'med',
    pinned: (s.pinned as boolean) ?? false,
  };
}

/** Collaboration entities (Act 3) share the op-log but are NOT tasks — a
 *  `member:` roster entry, a `comment:` thread, or a shared `project:` record
 *  must never project to a Task. */
export function isTaskEntity(id: string): boolean {
  return !id.startsWith('member:') && !id.startsWith('comment:') && !id.startsWith('project:');
}

/** Project an op-log to the full set of live + trashed tasks it represents. */
export function projectTasks(ops: Op[]): Task[] {
  return [...materialize(ops)]
    .filter(([id]) => isTaskEntity(id))
    .map(([id, state]) => entityStateToTask(id, state));
}

/** Shallow-but-deep-enough equality over the fields the op-log tracks. */
function sameTask(a: Task, b: Task): boolean {
  for (const k of PROJECTED_KEYS) {
    const va = (a as any)[k];
    const vb = (b as any)[k];
    if (va === vb) continue;
    if (JSON.stringify(va ?? null) !== JSON.stringify(vb ?? null)) return false;
  }
  return true;
}

export interface TaskDiff {
  upserts: Task[];   // present in the projection, missing or changed locally
  deletes: string[]; // present locally, absent from the projection (hard-deleted/tombstoned)
}

/**
 * What must change to make `current` match `projected`. The reconciler applies
 * exactly this — nothing more — so a sync touches only genuinely-moved rows.
 */
export function diffTasks(current: Task[], projected: Task[]): TaskDiff {
  const curById = new Map(current.map((t) => [t.id, t]));
  const projById = new Map(projected.map((t) => [t.id, t]));

  const upserts: Task[] = [];
  for (const p of projected) {
    const c = curById.get(p.id);
    if (!c || !sameTask(c, p)) upserts.push(p);
  }
  const deletes: string[] = [];
  for (const c of current) if (!projById.has(c.id)) deletes.push(c.id);

  return { upserts, deletes };
}
