import { describe, it, expect } from 'vitest';
import { Clock, setOp } from './oplog';
import { projectComments, projectAssignees, projectRoster } from './collabProjection';

const c = new Clock('A', 1000);
const set = (entity: string, field: string, value: any) => setOp(c, entity, field, value);

describe('collabProjection', () => {
  it('projects comments scoped to a task, oldest first', () => {
    const ops = [
      set('comment:s1:c1', 'task_id', 't1'),
      set('comment:s1:c1', 'author', 'A'),
      set('comment:s1:c1', 'body', 'first'),
      set('comment:s1:c1', 'created_at', '2026-01-01T10:00:00Z'),
      set('comment:s1:c2', 'task_id', 't1'),
      set('comment:s1:c2', 'author', 'B'),
      set('comment:s1:c2', 'body', 'second'),
      set('comment:s1:c2', 'created_at', '2026-01-01T11:00:00Z'),
      set('comment:s1:c3', 'task_id', 't2'), // different task
      set('comment:s1:c3', 'body', 'elsewhere'),
      set('comment:s1:c3', 'created_at', '2026-01-01T09:00:00Z'),
    ];
    const onT1 = projectComments(ops, 't1');
    expect(onT1.map((x) => x.body)).toEqual(['first', 'second']);
    expect(onT1[0]).toMatchObject({ shareId: 's1', taskId: 't1', author: 'A' });
    // Unscoped sees all three.
    expect(projectComments(ops)).toHaveLength(3);
  });

  it('omits comments with no body (deleted/empty)', () => {
    const ops = [set('comment:s1:c1', 'task_id', 't1'), set('comment:s1:c1', 'created_at', '2026-01-01')];
    expect(projectComments(ops)).toHaveLength(0);
  });

  it('projects the latest assignee per task and ignores collab entities', () => {
    const ops = [
      set('t1', 'title', 'Task one'),
      set('t1', 'assignee', 'A'),
      set('t1', 'assignee', 'B'), // later write wins
      set('t2', 'title', 'Task two'),
      set('comment:s1:c1', 'assignee', 'X'), // must be ignored
    ];
    const a = projectAssignees(ops);
    expect(a.get('t1')).toBe('B');
    expect(a.has('t2')).toBe(false);
    expect(a.has('comment:s1:c1')).toBe(false);
  });

  it('projects a share roster from member ops', () => {
    const ops = [
      set('member:s1:A', 'pub', 'pubA'),
      set('member:s1:A', 'role', 'owner'),
      set('member:s1:B', 'pub', 'pubB'),
      set('member:s1:B', 'role', 'editor'),
      set('member:s2:C', 'role', 'viewer'), // different share — excluded
    ];
    const roster = projectRoster(ops, 's1');
    expect(roster).toEqual([
      { actor: 'A', pub: 'pubA', role: 'owner' },
      { actor: 'B', pub: 'pubB', role: 'editor' },
    ]);
  });
});
