/** Existing rows are authoritative until replay parity is proved. This audit is
 * read-only; it reports every field gap, local tombstone conflict, and log-only
 * entity without treating absence as permission to delete data. */
import type { Task, Project } from '../store';
import { Clock, entityToOps, hlcCompare, canonicalJson, materialize, type Json, type Op } from './oplog';
import { TRACKED, actorId, ingestOps } from './oplogStore';
import { isTaskEntity } from './projector';
import { getAllTasks, getTrash, getProjects, loadOps, getCalendarEvents, getMilestones, getTemplates, IS_TAURI, setSetting, appendOps } from '../db';
import { createBackup } from './backupService';

export interface HistoryGap {
  entity: string;
  field: string | null;
  reason: 'missing-entity' | 'missing-field' | 'different-value' | 'local-row-after-tombstone' | 'log-only-entity';
  local?: Json;
  logged?: Json;
}
export interface HistoryAudit {
  id: string;
  version: 1;
  created_at: string;
  gaps: HistoryGap[];
  task_count: number;
  project_count: number;
  operation_count: number;
  parity: boolean;
  /** Original data, including Trash, is retained in the exported audit. */
  snapshot: { tasks: Task[]; projects: Project[]; ops: Op[] };
}

export function auditHistory(tasks: Task[], projects: Project[], ops: Op[]): HistoryAudit {
  const states = materialize(ops); // malformed/colliding history rejects the audit
  const seen = new Set<string>();
  const gaps: HistoryGap[] = [];
  const deleted = new Set(ops.filter(op => op.kind === 'del').map(op => op.entity));
  function compare(entity: string, values: Record<string, Json>) {
    seen.add(entity);
    const state = states.get(entity);
    if (!state) {
      gaps.push({ entity, field: null, reason: deleted.has(entity) ? 'local-row-after-tombstone' : 'missing-entity' });
    }
    for (const [field, local] of Object.entries(values)) {
      if (!state || !Object.prototype.hasOwnProperty.call(state, field)) {
        gaps.push({ entity, field, reason: 'missing-field', local });
      } else if (canonicalJson(local) !== canonicalJson(state[field])) {
        gaps.push({ entity, field, reason: 'different-value', local, logged: state[field] });
      }
    }
  }
  for (const task of tasks) {
    const values: Record<string, Json> = {};
    for (const field of TRACKED) {
      const value = task[field];
      // Do not manufacture fields absent from legacy rows; retain the raw row
      // in the snapshot so a later schema migration can account for them.
      if (value !== undefined) values[field] = value as Json;
    }
    compare(task.id, values);
  }
  for (const project of projects) {
    compare(`project:${project.id}`, { name: project.name, color: project.color, created_at: project.created_at, sort_order: project.sort_order });
  }
  for (const entity of states.keys()) {
    if ((isTaskEntity(entity) || entity.startsWith('project:')) && !seen.has(entity)) {
      gaps.push({ entity, field: null, reason: 'log-only-entity' });
    }
  }
  return {
    id: crypto.randomUUID(), version: 1, created_at: new Date().toISOString(), gaps,
    task_count: tasks.length, project_count: projects.length, operation_count: ops.length,
    parity: gaps.length === 0,
    snapshot: structuredClone({ tasks, projects, ops }),
  };
}

export async function captureHistoryAudit(): Promise<HistoryAudit> {
  // Sequential reads are explicitly a diagnostic snapshot, not a cutover lock.
  // Repair must revalidate this snapshot atomically before admitting any ops.
  const tasks = [...await getAllTasks('all'), ...await getTrash()] as Task[];
  return auditHistory(tasks, await getProjects(), await loadOps());
}

/** Preserve data before future repair. Export includes entities outside the
 * personal op-log. Desktop also takes a verified SQLite snapshot first. */
export async function exportHistoryAudit(): Promise<string> {
  const backup = IS_TAURI ? await createBackup('preaudit') : null;
  const audit = await captureHistoryAudit();
  const exportData = {
    kind: 'cognate-history-audit', version: 1, audit, backup,
    calendar_events: await getCalendarEvents(), milestones: await getMilestones(), templates: await getTemplates(),
    scope: 'Diagnostic data snapshot; excludes secrets, signing keys, and general settings. Not a full device recovery kit.',
  };
  const json = JSON.stringify(exportData, null, 2);
  // Retain a local copy before offering a download; quota/storage failure is
  // explicit and cannot be reported as a preserved snapshot.
  await setSetting(`history_audit_snapshot:${audit.id}`, json);
  return json;
}

export function normalizedTask(task: Task): Record<string, Json> {
  const values: Record<string, Json> = { id: task.id };
  for (const field of TRACKED) if (task[field] !== undefined) values[field] = task[field] as Json;
  return values;
}
export function fingerprint(tasks: unknown[], projects: unknown[], ops: Op[]): string {
  const sorted = (rows: unknown[]) => [...rows].sort((a, b) => String((a as {id:string}).id).localeCompare(String((b as {id:string}).id)));
  return canonicalJson({ tasks: sorted(tasks), projects: sorted(projects), ops: [...ops].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) } as unknown as Json);
}

/** Explicit, reversible local-row repair. No task/project rows are modified or
 * discarded, and log-only entities remain reported for individual review. */
export async function repairHistoryFromAudit(audit: HistoryAudit): Promise<number> {
  if (audit.version !== 1) throw new Error('Unsupported audit version.');
  if (IS_TAURI) await createBackup('prerepair');
  await setSetting(`history_audit_snapshot:${audit.id}`, JSON.stringify(audit));
  const clock = new Clock(await actorId(), Date.now());
  for (const op of audit.snapshot.ops) if (hlcCompare(op.hlc, clock.current()) > 0) clock.receive(op.hlc);
  const tasks = audit.snapshot.tasks.map(normalizedTask);
  const projects = audit.snapshot.projects;
  const values = new Map<string, Record<string, Json>>();
  for (const task of tasks) { const { id, ...fields } = task; values.set(String(id), fields); }
  for (const project of projects) {
    const { id, ...fields } = project;
    values.set(`project:${id}`, fields as Record<string, Json>);
  }
  const affected = new Set(audit.gaps.filter(gap => gap.reason !== 'log-only-entity').map(gap => gap.entity));
  const ops = [...affected].flatMap(entity => entityToOps(clock, entity, values.get(entity) ?? {}));
  if (ops.length) ops.push(...entityToOps(clock, `audit:${audit.id}`, {
    source: 'explicit-local-row-repair', snapshot_id: audit.id, created_at: audit.created_at,
    repaired_entities: [...affected],
  }));
  // Native: comparisons and append share one transaction. Browser: the final
  // comparison and single-key op-log write run synchronously without an await.
  await appendOps(ops, { tasks, projects, ops: audit.snapshot.ops, normalizeTask: normalizedTask, fingerprint });
  await ingestOps(ops); // advance the live clock past explicitly repaired history
  return ops.length;
}
