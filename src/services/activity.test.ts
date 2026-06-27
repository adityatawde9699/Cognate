import { describe, it, expect } from 'vitest';
import { Clock, setOp, delOp, type Op } from './oplog';
import { projectActivity } from './activity';

// Build ops with explicit wall times so coalescing/ordering is deterministic.
function ops(build: (mk: (entity: string, field: string, value: any, at: number) => Op, del: (e: string, at: number) => Op) => Op[]): Op[] {
  const c = new Clock('A', 0);
  const mk = (entity: string, field: string, value: any, at: number) => setOp(c, entity, field, value, at);
  const del = (entity: string, at: number) => delOp(c, entity, at);
  return build(mk, del);
}

describe('activity feed projection', () => {
  it('coalesces a create burst into one entry and shows the title', () => {
    const log = ops((mk) => [
      mk('t1', 'created_at', '2026-01-01', 1000),
      mk('t1', 'title', 'Write spec', 1001),
      mk('t1', 'importance', 5, 1002),
    ]);
    const feed = projectActivity(log, new Map([['t1', 'Write spec']]));
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'create', actor: 'A' });
    expect(feed[0].summary).toContain('Write spec');
  });

  it('separates edits outside the coalescing window', () => {
    const log = ops((mk) => [
      mk('t1', 'created_at', '2026-01-01', 1000),
      mk('t1', 'title', 'v1', 1001),
      mk('t1', 'title', 'v2', 1000 + 5 * 60_000), // well beyond the window
    ]);
    const feed = projectActivity(log);
    expect(feed.map((e) => e.kind)).toEqual(['edit', 'create']); // newest first
  });

  it('classifies complete, comment, assign and member events', () => {
    const log = ops((mk) => [
      mk('t1', 'done', true, 2000),
      mk('comment:s1:c1', 'body', 'nice', 3000),
      mk('t2', 'assignee', 'BBBBBBBB', 4000), // distinct entity → its own event
      mk('member:s1:CCCCCCCC', 'role', 'editor', 5000),
    ]);
    const feed = projectActivity(log, new Map([['t1', 'Task One']]));
    const byKind = Object.fromEntries(feed.map((e) => [e.kind, e.summary]));
    expect(byKind.complete).toContain('completed');
    expect(byKind.comment).toContain('commented');
    expect(byKind.assign).toContain('assigned');
    expect(byKind.assign).toContain('BBBBBBBB'.slice(0, 8));
    expect(byKind.member).toContain('editor');
  });

  it('reports deletions and orders newest-first with a limit', () => {
    const log = ops((mk, del) => [
      mk('t1', 'created_at', 'x', 1000),
      mk('t2', 'created_at', 'x', 2000),
      del('t1', 3000),
    ]);
    const feed = projectActivity(log, new Map(), 2);
    expect(feed).toHaveLength(2);
    expect(feed[0].kind).toBe('delete'); // newest
    expect(feed[0].at).toBe(3000);
  });
});
