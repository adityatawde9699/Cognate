/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/activity.ts — the activity feed (Act 3)
   ──────────────────────────────────────────────────────
   The op-log already records WHO did WHAT WHEN (op.hlc.actor + wall clock), so
   an activity feed is a pure projection: fold ops into human-readable events.
   Consecutive field-edits to one entity by one actor within a short window
   collapse into a single entry, so renaming a task doesn't spam the feed.
   No DB / network / React — exhaustively testable. See activity.test.ts.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { hlcCompare, type Op } from './oplog';

const WINDOW_MS = 60_000; // edits within a minute by the same actor coalesce

export type ActivityKind =
  | 'create' | 'complete' | 'reopen' | 'edit' | 'assign'
  | 'comment' | 'member' | 'delete' | 'restore';

export interface ActivityEntry {
  id: string;        // stable id for the coalesced event
  actor: string;     // who (CRDT actor id)
  at: number;        // when (wall ms)
  kind: ActivityKind;
  entity: string;    // the task/comment/member entity touched
  summary: string;   // human-readable description
}

const short = (s: string) => (s ? s.slice(0, 8) : 'someone');
const memberActorOf = (entity: string) => entity.split(':').pop() ?? '';

interface Group { actor: string; entity: string; at: number; ops: Op[] }

/** Classify a coalesced group of ops into one feed entry. `titles` resolves a
 *  task entity id → its current title for friendlier summaries. */
function classify(g: Group, titles: Map<string, string>): ActivityEntry {
  const who = short(g.actor);
  const name = () => titles.get(g.entity) ?? `task ${short(g.entity)}`;
  const base = { id: `${g.at}|${g.actor}|${g.entity}`, actor: g.actor, at: g.at, entity: g.entity };

  // Comments
  if (g.entity.startsWith('comment:')) {
    return { ...base, kind: 'comment', summary: `${who} commented` };
  }
  // Roster changes
  if (g.entity.startsWith('member:')) {
    const target = short(memberActorOf(g.entity));
    if (g.ops.some((o) => o.kind === 'del')) return { ...base, kind: 'member', summary: `${who} removed ${target}` };
    const roleOp = g.ops.find((o) => o.kind === 'set' && o.field === 'role');
    if (roleOp && roleOp.kind === 'set') return { ...base, kind: 'member', summary: `${who} set ${target} as ${roleOp.value}` };
    return { ...base, kind: 'member', summary: `${who} added ${target}` };
  }
  // Task entities — pick the highest-signal change in the group.
  if (g.ops.some((o) => o.kind === 'del')) return { ...base, kind: 'delete', summary: `${who} deleted ${name()}` };

  const sets = g.ops.filter((o): o is Extract<Op, { kind: 'set' }> => o.kind === 'set');
  const field = (f: string) => sets.find((o) => o.field === f);

  if (field('created_at')) return { ...base, kind: 'create', summary: `${who} created ${name()}` };

  const done = field('done');
  if (done) return { ...base, kind: done.value ? 'complete' : 'reopen', summary: `${who} ${done.value ? 'completed' : 'reopened'} ${name()}` };

  const del = field('deleted_at');
  if (del) return del.value
    ? { ...base, kind: 'delete', summary: `${who} moved ${name()} to Trash` }
    : { ...base, kind: 'restore', summary: `${who} restored ${name()}` };

  const assignee = field('assignee');
  if (assignee) return { ...base, kind: 'assign', summary: `${who} assigned ${name()} to ${short(String(assignee.value))}` };

  return { ...base, kind: 'edit', summary: `${who} edited ${name()}` };
}

/**
 * Project an op-log into a newest-first activity feed. `titles` (optional) maps
 * task ids to titles for nicer summaries. `limit` caps the result.
 */
export function projectActivity(ops: Op[], titles: Map<string, string> = new Map(), limit = 50): ActivityEntry[] {
  const ordered = [...ops].sort((a, b) => hlcCompare(a.hlc, b.hlc));

  // Coalesce by (actor, entity, time-window).
  const groups: Group[] = [];
  const open = new Map<string, Group>(); // key actor|entity → current open group
  for (const op of ordered) {
    const key = `${op.hlc.actor}|${op.entity}`;
    const g = open.get(key);
    if (g && op.hlc.wall - g.at <= WINDOW_MS) {
      g.ops.push(op);
      g.at = op.hlc.wall; // extend the window to the latest op
    } else {
      const ng: Group = { actor: op.hlc.actor, entity: op.entity, at: op.hlc.wall, ops: [op] };
      open.set(key, ng);
      groups.push(ng);
    }
  }

  return groups
    .map((g) => classify(g, titles))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}
