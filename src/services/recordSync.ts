/* Milestones and templates replicate through the op-log like projects: each
   record is an entity (`milestone:<id>`, `template:<id>`) and every field is
   last-writer-wins by HLC. Settings are deliberately not replicated; they hold
   device paths, keys and per-device preferences. */
import { entityToOps, delOp, canonicalJson, type Clock, type EntityState, type Json, type Op } from './oplog';

export interface Milestone { id: string; project_id: string | null; name: string; due: string; created_at: string; sort_order: number }
export interface TemplateRecord { id: string; name: string; data: Json; created_at: string }
export interface SyncedRecords { milestones: Milestone[]; templates: TemplateRecord[] }

export const RECORD_KINDS = {
  milestones: { prefix: 'milestone:', fields: ['project_id', 'name', 'due', 'created_at', 'sort_order'] },
  templates: { prefix: 'template:', fields: ['name', 'data', 'created_at'] },
} as const;
export type RecordKind = keyof typeof RECORD_KINDS;

export function isRecordEntity(entity: string): boolean {
  return entity.startsWith(RECORD_KINDS.milestones.prefix) || entity.startsWith(RECORD_KINDS.templates.prefix);
}

function fieldsOf(kind: RecordKind, row: Record<string, unknown>): Record<string, Json> {
  const fields: Record<string, Json> = {};
  for (const field of RECORD_KINDS[kind].fields) fields[field] = (row[field] ?? (field === 'project_id' ? null : '')) as Json;
  if (kind === 'milestones') fields.sort_order = Number(row.sort_order ?? 0);
  return fields;
}

/** Ops that turn the `before` list into the `after` list (changed fields only). */
export function recordOps(clock: Clock, kind: RecordKind, before: readonly Record<string, unknown>[], after: readonly Record<string, unknown>[]): Op[] {
  const prefix = RECORD_KINDS[kind].prefix;
  const old = new Map(before.map(row => [String(row.id), fieldsOf(kind, row)]));
  const ops: Op[] = [];
  const kept = new Set<string>();
  for (const row of after) {
    const id = String(row.id);
    kept.add(id);
    const next = fieldsOf(kind, row);
    const previous = old.get(id);
    const changed: Record<string, Json> = {};
    for (const [field, value] of Object.entries(next)) {
      if (!previous || canonicalJson(previous[field]) !== canonicalJson(value)) changed[field] = value;
    }
    if (Object.keys(changed).length) ops.push(...entityToOps(clock, `${prefix}${id}`, changed));
  }
  for (const id of old.keys()) if (!kept.has(id)) ops.push(delOp(clock, `${prefix}${id}`));
  return ops;
}

/** Records that exist locally but have never been logged (data from before
 * record sync). Logging them once lets other devices receive them. */
export function unloggedRecordOps(clock: Clock, local: SyncedRecords, states: Map<string, EntityState>, ops: readonly Op[]): Op[] {
  const touched = new Set(ops.map(op => op.entity));
  const out: Op[] = [];
  for (const kind of Object.keys(RECORD_KINDS) as RecordKind[]) {
    const rows = local[kind] as unknown as Record<string, unknown>[];
    for (const row of rows) {
      const entity = `${RECORD_KINDS[kind].prefix}${row.id}`;
      if (!touched.has(entity) && !states.has(entity)) out.push(...entityToOps(clock, entity, fieldsOf(kind, row)));
    }
  }
  return out;
}

/** Rebuild milestones and templates from merged history. A record the UI
 * cannot show is skipped rather than failing the whole sync; its ops stay in
 * history, so a later valid edit brings it back. */
export function projectRecords(states: Map<string, EntityState>): SyncedRecords {
  const milestones: Milestone[] = [];
  const templates: TemplateRecord[] = [];
  for (const [entity, s] of states) {
    if (entity.startsWith(RECORD_KINDS.milestones.prefix)) {
      const id = entity.slice(RECORD_KINDS.milestones.prefix.length);
      if (typeof s.name !== 'string' || !s.name.trim()) continue;
      milestones.push({
        id, name: s.name, project_id: typeof s.project_id === 'string' ? s.project_id : null,
        due: typeof s.due === 'string' ? s.due : '', created_at: String(s.created_at ?? ''),
        sort_order: Number.isFinite(Number(s.sort_order)) ? Number(s.sort_order) : 0,
      });
    } else if (entity.startsWith(RECORD_KINDS.templates.prefix)) {
      const id = entity.slice(RECORD_KINDS.templates.prefix.length);
      const data = s.data as { tasks?: unknown } | null;
      if (typeof s.name !== 'string' || !s.name.trim() || !data || typeof data !== 'object' || !Array.isArray(data.tasks)) continue;
      templates.push({ id, name: s.name, data: s.data as Json, created_at: String(s.created_at ?? '') });
    }
  }
  milestones.sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at));
  templates.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return { milestones, templates };
}
