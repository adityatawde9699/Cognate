/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/syncService.ts — manual two-device sync (Act 2)
   ──────────────────────────────────────────────────────
   Portable operation bundles and live relay pulls use one guarded projection
   commit. Historical local gaps must be explicitly audited/repaired first;
   incoming operations and projected rows commit together with preconditions.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { loadOps, commitProjection } from '../db';
import { merge, materialize, validateOps, type Op } from './oplog';
import { projectTasks, diffTasks } from './projector';
import { observeOps } from './oplogStore';
import { loadAllTasks } from './taskService';
import { useStore, type Project } from '../store';

import { captureHistoryAudit, normalizedTask, fingerprint } from './historyAudit';

const BUNDLE_KIND = 'cognate-oplog-bundle';
const BUNDLE_VERSION = 1;

export interface SyncBundle {
  app: 'cognate';
  kind: typeof BUNDLE_KIND;
  version: number;
  exported_at: string;
  ops: Op[];
}

/** Serialize this device's entire op-log into a portable, mergeable bundle. */
export async function exportBundle(): Promise<string> {
  const bundle: SyncBundle = {
    app: 'cognate',
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    ops: await loadOps(),
  };
  return JSON.stringify(bundle, null, 2);
}

function parseBundle(json: string): Op[] {
  let parsed: any;
  try { parsed = JSON.parse(json); } catch { throw new Error('Not a valid sync bundle (bad JSON).'); }
  if (!parsed || parsed.kind !== BUNDLE_KIND || !Array.isArray(parsed.ops)) {
    throw new Error('Not a Cognate sync bundle.');
  }
  if (parsed.app !== 'cognate' || parsed.version !== BUNDLE_VERSION) {
    throw new Error('This bundle was made by a newer version of Cognate.');
  }
  validateOps(parsed.ops);
  return parsed.ops;
}

/**
 * Commit admitted history and its full projection together after checking
 * the audited local snapshot; then refresh the view.
 */
export async function mergeIntoApp(incoming: Op[]): Promise<{ applied: number; upserts: number; deletes: number }> {
  validateOps(incoming);
  const audit = await captureHistoryAudit();
  if (audit.gaps.some(gap => gap.reason !== 'log-only-entity')) {
    throw new Error('Local rows differ from saved history. Export and review a history audit in Settings before syncing.');
  }
  const merged = merge(audit.snapshot.ops, incoming);
  const tasks = projectTasks(merged);
  for (const task of tasks) {
    if (typeof task.title !== 'string' || !task.title.trim() || !Array.isArray(task.tags) ||
        !task.tags.every(tag => typeof tag === 'string') || typeof task.done !== 'boolean' ||
        !Number.isInteger(task.importance) || task.importance < 1 || task.importance > 5 ||
        !Number.isInteger(task.effort) || task.effort < 1 || task.effort > 5) {
      throw new Error('Incoming history produces an invalid task. No data was imported.');
    }
  }
  const projects: Project[] = [];
  for (const [entity,state] of materialize(merged)) if (entity.startsWith('project:')) {
    const id = entity.slice('project:'.length);
    const existing = audit.snapshot.projects.find(project => project.id === id);
    projects.push({ id, name: String(state.name ?? existing?.name ?? ''), color: String(state.color ?? existing?.color ?? ''),
      created_at: String(state.created_at ?? existing?.created_at ?? ''), sort_order: Number(state.sort_order ?? existing?.sort_order ?? 0) });
  }
  const { upserts, deletes } = diffTasks(audit.snapshot.tasks, tasks);
  await commitProjection(incoming, tasks, projects, {
    tasks: audit.snapshot.tasks.map(normalizedTask), projects: audit.snapshot.projects,
    ops: audit.snapshot.ops, normalizeTask: normalizedTask, fingerprint,
  });
  await observeOps(incoming);
  const filter = useStore.getState().currentFilter;
  await loadAllTasks(filter);
  useStore.getState().setProjects(projects);
  return { applied: incoming.length, upserts: upserts.length, deletes: deletes.length };
}

export async function reconcileIntoApp(): Promise<{ upserts: number; deletes: number }> {
  return mergeIntoApp([]);
}

export async function importBundle(json: string): Promise<{ applied: number; upserts: number; deletes: number }> {
  return mergeIntoApp(parseBundle(json));
}
