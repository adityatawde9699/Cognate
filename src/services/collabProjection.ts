/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/collabProjection.ts — projecting collaboration state (Act 3)
   ──────────────────────────────────────────────────────
   The op-log carries more than tasks now: `comment:<shareId>:<id>` threads, an
   `assignee` field on shared tasks, and the `member:<shareId>:<actor>` roster.
   These never become Tasks (projector.ts skips them) — they project to their
   own shapes here. Pure data → data, so it's unit-testable in isolation and
   shared by every client. Authorization happens upstream (collab.ts) before
   these ops ever reach the local log; this layer just folds.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { materialize, type Op } from './oplog';
import type { Member, Role } from './collab';

export interface Comment {
  id: string;       // the full entity id (comment:<shareId>:<uuid>)
  shareId: string;
  taskId: string;
  author: string;   // actor id of the commenter
  body: string;
  createdAt: string;
  resolved: boolean;
}

const COMMENT = 'comment:';
const MEMBER = 'member:';
const PROJECT = 'project:';

export interface SharedProject { id: string; name: string; color: string }

/** Shared project records carried in the op-log, so a joiner sees the project
 *  named and grouped rather than a pile of ungrouped tasks. */
export function projectSharedProjects(ops: Op[]): SharedProject[] {
  const out: SharedProject[] = [];
  for (const [id, s] of materialize(ops)) {
    if (!id.startsWith(PROJECT)) continue;
    const name = (s.name as string) ?? '';
    if (!name) continue;
    out.push({ id: id.slice(PROJECT.length), name, color: (s.color as string) ?? '' });
  }
  return out;
}

/** Project every comment thread in the log (optionally scoped to one task). */
export function projectComments(ops: Op[], taskId?: string): Comment[] {
  const out: Comment[] = [];
  for (const [id, s] of materialize(ops)) {
    if (!id.startsWith(COMMENT)) continue;
    const [, shareId = ''] = id.split(':');
    const body = (s.body as string) ?? '';
    const tId = (s.task_id as string) ?? '';
    if (!body) continue; // a deleted/empty comment doesn't render
    if (taskId && tId !== taskId) continue;
    out.push({
      id,
      shareId,
      taskId: tId,
      author: (s.author as string) ?? '',
      body,
      createdAt: (s.created_at as string) ?? '',
      resolved: (s.resolved as boolean) ?? false,
    });
  }
  // Oldest first — natural reading order for a thread.
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** taskId → assignee actor id, for tasks that carry an `assignee` field. */
export function projectAssignees(ops: Op[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, s] of materialize(ops)) {
    if (id.startsWith(COMMENT) || id.startsWith(MEMBER)) continue;
    const a = s.assignee;
    if (typeof a === 'string' && a) out.set(id, a);
  }
  return out;
}

/**
 * The roster of a share, folded from its local `member:` ops. Safe for display:
 * remote member ops only reach the local log after passing authorization on
 * pull (shareService.pullShare → collab.authorize), and our own are trusted.
 */
export function projectRoster(ops: Op[], shareId: string): Member[] {
  const prefix = `${MEMBER}${shareId}:`;
  const out: Member[] = [];
  for (const [id, s] of materialize(ops)) {
    if (!id.startsWith(prefix)) continue;
    const actor = id.slice(prefix.length);
    const m: Member = { actor, pub: (s.pub as string) ?? '', role: ((s.role as Role) ?? 'viewer') };
    if (typeof s.work_start === 'number') m.work_start_min = s.work_start as number;
    if (typeof s.work_end === 'number') m.work_end_min = s.work_end as number;
    out.push(m);
  }
  return out.sort((a, b) => (a.actor < b.actor ? -1 : 1));
}
