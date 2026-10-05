import { describe, it, expect } from 'vitest';
import { auditHistory } from './historyAudit';
import { Clock, entityToOps, delOp, setOp } from './oplog';
import type { Task, Project } from '../store';
const task = { id: 'task', title: 'Latest local edit', done: false, deleted_at: null, duration_min: 90, min_block: 15, max_block: 120 } as Task;

describe('historical row/history discrepancy audit', () => {
  it('reports changed and missing fields even when an entity already occurs in the log', () => {
    const clock = new Clock('device');
    const ops = [setOp(clock, 'task', 'title', 'Old title', 1)];
    const report = auditHistory([task], [], ops);
    expect(report.parity).toBe(false);
    expect(report.gaps).toContainEqual({ entity: 'task', field: 'title', reason: 'different-value', local: 'Latest local edit', logged: 'Old title' });
    expect(report.gaps).toContainEqual({ entity: 'task', field: 'duration_min', reason: 'missing-field', local: 90 });
    expect(report.gaps).toContainEqual({ entity: 'task', field: 'min_block', reason: 'missing-field', local: 15 });
    expect(report.snapshot.tasks).toEqual([task]);
    report.snapshot.tasks[0].title = 'snapshot mutation';
    expect(task.title).toBe('Latest local edit');
  });
  it('retains Trash and tombstone disagreements without deleting or reviving anything', () => {
    const trash = { ...task, deleted_at: '2026-10-06' };
    const ops = [delOp(new Clock('device'), task.id, 1)];
    const report = auditHistory([trash], [], ops);
    expect(report.gaps).toContainEqual({ entity: task.id, field: null, reason: 'local-row-after-tombstone' });
    expect(report.snapshot.tasks[0].deleted_at).toBe('2026-10-06');
    expect(report.snapshot.ops).toEqual(ops);
  });
  it('reports project gaps and log-only rows but excludes comments and members', () => {
    const project = { id: 'p', name: 'Local project', color: '#123', created_at: '2026-01-01', sort_order: 0 } as Project;
    const clock = new Clock('device');
    const ops = [setOp(clock, 'remote', 'title', 'Remote'), setOp(clock, 'comment:c', 'body', 'Comment'), setOp(clock, 'member:a', 'role', 'editor')];
    const report = auditHistory([], [project], ops);
    expect(report.gaps).toContainEqual({ entity: 'project:p', field: 'name', reason: 'missing-field', local: 'Local project' });
    expect(report.gaps).toContainEqual({ entity: 'remote', field: null, reason: 'log-only-entity' });
    expect(report.gaps.some(gap => gap.entity.startsWith('comment:') || gap.entity.startsWith('member:'))).toBe(false);
  });
  it('compares nested JSON independent of object-key order', () => {
    const local = { id:'task', custom_fields: { a:'a', b:'b' } } as unknown as Task;
    const ops = entityToOps(new Clock('device'), 'task', {custom_fields:{ b:'b', a:'a' }});
    expect(auditHistory([local], [], ops).parity).toBe(true);
  });
});

import { beforeEach } from 'vitest';
import { repairHistoryFromAudit, captureHistoryAudit } from './historyAudit';
import { getAllTasks, loadOps, setSchedule } from '../db';
import { _resetForTests } from './oplogStore';

class Storage {
  values = new Map<string,string>();
  getItem(key:string) { return this.values.get(key) ?? null; }
  setItem(key:string,value:string) { this.values.set(key,value); }
}
describe('explicit historical repair', () => {
  beforeEach(() => { Object.assign(globalThis, {localStorage:new Storage()}); _resetForTests(); });
  it('repairs stale schedule and missing fields while preserving rows and a snapshot', async () => {
    const task = {id:'legacy',title:'Local work', description:'', deadline:'', tags:[],importance:3,effort:3};
    localStorage.setItem('cn_tasks_v2',JSON.stringify([task]));
    // Historical schedule bypassed logging in the old release.
    localStorage.setItem('cn_tasks_v2',JSON.stringify([{...task,scheduled_start:'2026-10-06T10:00:00',scheduled_end:'2026-10-06T11:00:00'}]));
    const report = await captureHistoryAudit();
    const before = await getAllTasks('all');
    expect(report.parity).toBe(false);
    expect(await repairHistoryFromAudit(report)).toBeGreaterThan(0);
    expect(await getAllTasks('all')).toEqual(before);
    expect((await captureHistoryAudit()).parity).toBe(true);
    expect(localStorage.getItem(`cn_set_history_audit_snapshot:${report.id}`)).toBeTruthy();
    expect((await loadOps()).some(op => op.entity === `audit:${report.id}`)).toBe(true);
  });
  it('rejects stale audits without admitting repair operations', async () => {
    const task = {id:'legacy',title:'Local work', description:'',deadline:'',tags:[],importance:3,effort:3};
    localStorage.setItem('cn_tasks_v2',JSON.stringify([task]));
    const report = await captureHistoryAudit();
    await setSchedule(task.id,'2026-10-06T12:00:00','2026-10-06T13:00:00');
    await expect(repairHistoryFromAudit(report)).rejects.toThrow('changed since the audit');
    expect((await loadOps()).some(op => op.entity.startsWith('audit:'))).toBe(false);
    expect((await getAllTasks('all'))[0].scheduled_start).toBe('2026-10-06T12:00:00');
  });
});
