/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/syncService.ts — manual two-device sync (Act 2)
   ──────────────────────────────────────────────────────
   The relay isn't built yet, but the CRDT spine already supports it: export
   the op-log as a portable bundle, import another device's bundle, and the
   merge is conflict-free. Importing reconciles the merged projection back into
   SQLite + the store — proving "SQLite is a projection of the op-log" and that
   two devices converge, end-to-end, before any network code exists.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { loadOps, upsertTaskRaw, deleteTask as dbDeleteTask, getAllTasks, getTrash } from '../db';
import type { Op } from './oplog';
import { projectTasks, diffTasks } from './projector';
import { ingestOps } from './oplogStore';
import { loadAllTasks } from './taskService';
import { useStore, type Task } from '../store';

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
  if (parsed.version > BUNDLE_VERSION) {
    throw new Error('This bundle was made by a newer version of Cognate.');
  }
  // Keep only structurally-valid ops.
  return parsed.ops.filter(
    (o: any) => o && o.id && o.hlc && typeof o.entity === 'string' && (o.kind === 'set' || o.kind === 'del')
  );
}

/**
 * Make SQLite + the store match the current op-log projection. Writes only
 * the rows that actually moved (via `diffTasks`), then refreshes the view.
 */
export async function reconcileIntoApp(): Promise<{ upserts: number; deletes: number }> {
  const ops = await loadOps();
  const projected = projectTasks(ops);

  const live = (await getAllTasks('all')) as Task[];
  const trash = (await getTrash()) as Task[];
  const current = [...live, ...trash];

  const { upserts, deletes } = diffTasks(current, projected);
  for (const t of upserts) await upsertTaskRaw(t);
  for (const id of deletes) await dbDeleteTask(id);

  // Reflect the merged truth in whatever view is open.
  const f = useStore.getState().currentFilter;
  await loadAllTasks(f === 'trash' ? 'trash' : 'all');

  return { upserts: upserts.length, deletes: deletes.length };
}

/**
 * Import another device's bundle: merge its ops (conflict-free), advance our
 * clock past them, then reconcile. Returns what changed locally.
 */
export async function importBundle(json: string): Promise<{ applied: number; upserts: number; deletes: number }> {
  const incoming = parseBundle(json);
  const applied = await ingestOps(incoming);
  const { upserts, deletes } = await reconcileIntoApp();
  return { applied, upserts, deletes };
}
