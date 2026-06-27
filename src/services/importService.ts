/* Import tasks from other tools. Auto-detects Cognate JSON, Todoist JSON,
   Trello board JSON, and generic CSV exports. */
import { addTask } from './taskService';

export interface ImportDraft {
  title: string;
  description: string;
  deadline: string;
  tags: string[];
  importance: number;
  effort: number;
}

const impFromPriority = (p?: string) =>
  p === 'high' ? 5 : p === 'low' ? 2 : 3;

function clampDate(s?: string): string {
  if (!s) return '';
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function parseCSV(text: string): ImportDraft[] {
  const rows: string[][] = [];
  let cur: string[] = [], val = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { val += '"'; i++; }
      else if (c === '"') q = false;
      else val += c;
    } else if (c === '"') q = true;
    else if (c === ',') { cur.push(val); val = ''; }
    else if (c === '\n' || c === '\r') { if (val !== '' || cur.length) { cur.push(val); rows.push(cur); cur = []; val = ''; } }
    else val += c;
  }
  if (val !== '' || cur.length) { cur.push(val); rows.push(cur); }
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const ci = { title: col('title', 'name', 'content', 'task'), desc: col('description', 'desc', 'notes'), due: col('deadline', 'due', 'due date', 'date'), prio: col('priority'), tags: col('tags', 'labels') };

  return rows.slice(1).filter((r) => r[ci.title]?.trim()).map((r) => ({
    title: r[ci.title].trim(),
    description: ci.desc >= 0 ? (r[ci.desc] || '').trim() : '',
    deadline: ci.due >= 0 ? clampDate(r[ci.due]) : '',
    tags: ci.tags >= 0 ? (r[ci.tags] || '').split(/[;,]/).map((t) => t.trim()).filter(Boolean) : [],
    importance: ci.prio >= 0 ? impFromPriority((r[ci.prio] || '').toLowerCase()) : 3,
    effort: 3,
  }));
}

function fromObjects(arr: any[]): ImportDraft[] {
  return arr.map((o) => ({
    title: String(o.title ?? o.content ?? o.name ?? '').trim(),
    description: String(o.description ?? o.desc ?? o.notes ?? '').trim(),
    deadline: clampDate(
      o.deadline ?? o.due_date ?? o.dueDate ??
      (o.due && typeof o.due === 'object' ? o.due.date : o.due)
    ),
    tags: Array.isArray(o.tags) ? o.tags.map(String) : Array.isArray(o.labels) ? o.labels.map((l: any) => String(l.name ?? l)) : [],
    importance: typeof o.importance === 'number' ? o.importance : impFromPriority(o.priority),
    effort: typeof o.effort === 'number' ? o.effort : 3,
  })).filter((d) => d.title);
}

/** Detect format and produce task drafts. */
export function parseImport(filename: string, text: string): ImportDraft[] {
  const isJson = filename.toLowerCase().endsWith('.json') || text.trim().startsWith('{') || text.trim().startsWith('[');
  if (!isJson) return parseCSV(text);

  let data: any;
  try { data = JSON.parse(text); } catch { return []; }

  if (Array.isArray(data)) return fromObjects(data);
  if (Array.isArray(data.items)) return fromObjects(data.items);          // Todoist
  if (Array.isArray(data.cards)) return fromObjects(data.cards.filter((c: any) => !c.closed)); // Trello
  if (Array.isArray(data.tasks)) return fromObjects(data.tasks);
  return [];
}

export async function importTasks(drafts: ImportDraft[]): Promise<number> {
  for (const d of drafts) {
    await addTask({
      title: d.title,
      description: d.description,
      deadline: d.deadline,
      tags: d.tags,
      importance: Math.min(5, Math.max(1, d.importance || 3)),
      effort: Math.min(5, Math.max(1, d.effort || 3)),
    });
  }
  return drafts.length;
}
