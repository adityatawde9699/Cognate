/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/nlQuickAdd.ts — natural-language quick-add parser (Act 4)
   ──────────────────────────────────────────────────────
   "call Sam tmrw 5pm 30m #work !!" → a structured, ready-to-schedule task.
   Deterministic and PURE (no AI, no I/O), exactly like the planner: quick-add
   works offline and privately; AI only *enriches* an ambiguous parse later.
   Extracts tags, priority, duration, a clock time, and a date, then leaves the
   remaining words as the title. Exhaustively unit-tested (nlQuickAdd.test.ts).
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export interface QuickAddResult {
  title: string;
  tags: string[];
  deadline: string;             // 'YYYY-MM-DD' (local) or ''
  startMin: number | null;      // minutes-from-midnight, if a clock time was given
  durationMin: number | null;   // explicit estimate, if given
  importance: number;           // 1–5 (drives the computed priority)
  priorityLabel: 'low' | 'medium' | 'high' | null; // for a preview chip
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10,
  november: 10, dec: 11, december: 11,
};

/** Next occurrence of a weekday strictly after today (1–7 days out). */
function nextWeekday(now: Date, target: number): Date {
  const delta = ((target - now.getDay() + 7) % 7) || 7;
  return addDays(now, delta);
}

export function parseQuickAdd(input: string, now: Date = new Date()): QuickAddResult {
  let s = ` ${input} `;
  const tags: string[] = [];

  // ── #tags ──
  s = s.replace(/#([\w-]+)/g, (_, t) => { tags.push(String(t).toLowerCase()); return ' '; });

  // ── priority (!, !!, !!! or p1/p2/p3), whitespace-delimited only ──
  let importance = 3;
  let priorityLabel: QuickAddResult['priorityLabel'] = null;
  s = s.replace(/(\s)(!{1,3}|p[1-3])(?=\s)/gi, (_, sp, tok: string) => {
    const t = tok.toLowerCase();
    const level = t.startsWith('p') ? Number(t[1]) : 4 - t.length; // p1/!!!→1(high) … p3/!→3
    if (level <= 1) { importance = 5; priorityLabel = 'high'; }
    else if (level === 2) { importance = 4; priorityLabel = 'high'; }
    else { importance = 3; priorityLabel = 'medium'; }
    return sp;
  });

  // ── clock time (before duration, so "pm" never reads as minutes) ──
  let startMin: number | null = null;
  const setTime = (h: number, m: number) => { if (h >= 0 && h < 24 && m >= 0 && m < 60) startMin = h * 60 + m; };
  s = s.replace(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i, (_m, h, mm, ap) => {
    let hr = Number(h) % 12;
    if (/pm/i.test(ap)) hr += 12;
    setTime(hr, mm ? Number(mm) : 0);
    return ' ';
  });
  if (startMin === null) {
    s = s.replace(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/, (_m, h, mm) => { setTime(Number(h), Number(mm)); return ' '; });
  }
  if (startMin === null) s = s.replace(/\bnoon\b/i, () => { startMin = 12 * 60; return ' '; });
  if (startMin === null) s = s.replace(/\bmidnight\b/i, () => { startMin = 0; return ' '; });

  // ── duration (1h, 30m, 1h30m, 90min, 2 hours) ──
  let durationMin: number | null = null;
  s = s.replace(/\b(\d+)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*m(?:in(?:ute)?s?)?)?\b/i, (_m, h, mm) => {
    durationMin = Number(h) * 60 + (mm ? Number(mm) : 0);
    return ' ';
  });
  if (durationMin === null) {
    s = s.replace(/\b(\d+)\s*m(?:in(?:ute)?s?)?\b/i, (_m, mm) => { durationMin = Number(mm); return ' '; });
  }

  // ── date ──
  let deadline = '';
  const setDate = (d: Date) => { deadline = ymd(d); };
  const rules: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [/\b(today|tonight)\b/i, () => setDate(now)],
    [/\b(tomorrow|tmrw|tmw|tom)\b/i, () => setDate(addDays(now, 1))],
    [/\bin\s+(\d+)\s+days?\b/i, (m) => setDate(addDays(now, Number(m[1])))],
    [/\bin\s+(\d+)\s+weeks?\b/i, (m) => setDate(addDays(now, Number(m[1]) * 7))],
    [/\bnext\s+week\b/i, () => setDate(addDays(now, 7))],
    [/\bnext\s+(\w+)\b/i, (m) => { const w = WEEKDAYS[m[1].toLowerCase()]; if (w !== undefined) setDate(addDays(nextWeekday(now, w), 7)); }],
    [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => setDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])))],
    [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
      const yr = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : now.getFullYear();
      setDate(new Date(yr, Number(m[1]) - 1, Number(m[2])));
    }],
    [/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/i, (m) => {
      const mo = MONTHS[m[1].toLowerCase()];
      if (mo !== undefined) { const d = new Date(now.getFullYear(), mo, Number(m[2])); if (d < addDays(now, -1)) d.setFullYear(d.getFullYear() + 1); setDate(d); }
    }],
    [/\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
      (m) => { const w = WEEKDAYS[m[1].toLowerCase()]; if (w !== undefined) setDate(nextWeekday(now, w)); }],
  ];
  for (const [re, apply] of rules) {
    const m = s.match(re);
    if (m) { apply(m); s = s.replace(re, ' '); if (deadline) break; }
  }

  // ── title = what's left ──
  const title = s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '')
    .replace(/\b(on|at|by|due|every)\s*$/i, '')
    .trim();

  return { title, tags, deadline, startMin, durationMin, importance, priorityLabel };
}

/** Structured fields an AI enricher may return for an ambiguous line. */
export interface QuickAddAIFields {
  title?: string;
  deadline?: string;
  startMin?: number | null;
  durationMin?: number | null;
  tags?: string[];
  importance?: number;
}

/**
 * Merge an AI enrichment over a deterministic parse — the deterministic result
 * always wins where it found something; AI only fills the gaps. Pure, so the
 * (non-deterministic) AI call stays out of the tested logic.
 */
export function mergeQuickAdd(base: QuickAddResult, ai: QuickAddAIFields): QuickAddResult {
  const importanceExplicit = base.priorityLabel !== null;
  const importance = importanceExplicit ? base.importance : ai.importance ?? base.importance;
  const labelFor = (imp: number): QuickAddResult['priorityLabel'] => (imp >= 4 ? 'high' : imp <= 2 ? 'low' : 'medium');
  return {
    title: base.title || (ai.title ?? '').trim(),
    tags: [...new Set([...base.tags, ...((ai.tags ?? []).map((t) => String(t).toLowerCase()))])],
    deadline: base.deadline || (ai.deadline ?? ''),
    startMin: base.startMin ?? (ai.startMin ?? null),
    durationMin: base.durationMin ?? (ai.durationMin ?? null),
    importance,
    priorityLabel: base.priorityLabel ?? (ai.importance ? labelFor(importance) : null),
  };
}

/** A short human preview of a parse, for the command-palette chip. */
export function quickAddPreview(r: QuickAddResult): string {
  const parts: string[] = [];
  if (r.deadline) parts.push(r.deadline);
  if (r.startMin !== null) {
    const h = Math.floor(r.startMin / 60), m = r.startMin % 60;
    const ap = h >= 12 ? 'PM' : 'AM';
    parts.push(`${((h + 11) % 12) + 1}:${pad(m)} ${ap}`);
  }
  if (r.durationMin) parts.push(`${r.durationMin}m`);
  if (r.priorityLabel === 'high') parts.push('high');
  for (const t of r.tags) parts.push(`#${t}`);
  return parts.join(' · ');
}
