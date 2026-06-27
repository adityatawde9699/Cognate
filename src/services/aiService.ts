/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/aiService.ts — Notion-style AI helpers
   Calls the Rust `ai_generate` command, which talks to the
   Claude Messages API using the key stored in Settings → AI.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { getSetting } from '../db';
import { getSecret } from '../utils/secrets';
import { Task } from '../store';
import type { QuickAddAIFields } from './nlQuickAdd';

/** Providers that run locally and don't require an API key. */
const LOCAL_PROVIDERS = ['ollama', 'llamacpp', 'custom'];

/** Low-level call into the Rust backend. */
async function generate(system: string, prompt: string, maxTokens?: number): Promise<string> {
  if (!(window as any).__TAURI_INTERNALS__) {
    throw new Error('AI features require the desktop app (Tauri).');
  }

  const provider = (await getSetting('ai_provider', 'anthropic')) || 'anthropic';
  const apiKey = await getSecret('ai_api_key');
  if (!apiKey && !LOCAL_PROVIDERS.includes(provider)) {
    throw new Error('No API key set. Add one in Settings → AI.');
  }
  const model = await getSetting('ai_model', '');
  const baseUrl = await getSetting('ai_base_url', '');

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('ai_generate', {
    args: {
      apiKey,
      provider,
      baseUrl: baseUrl || null,
      model: model || null,
      system,
      prompt,
      maxTokens: maxTokens ?? null,
    },
  });
}

/** Strip code fences / surrounding prose and parse the first JSON value. */
export function parseJSON<T>(raw: string): T {
  let s = (raw ?? '').trim();
  // Remove ```json … ``` or ``` … ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Otherwise slice from the first bracket to the last matching one.
  if (s[0] !== '{' && s[0] !== '[') {
    const start = s.search(/[[{]/);
    const end = Math.max(s.lastIndexOf(']'), s.lastIndexOf('}'));
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
  }
  // If there's no JSON at all, the model/endpoint returned prose or an error
  // (e.g. a provider that replies "User error" with HTTP 200). Surface *that*
  // instead of a cryptic "Unexpected token" so the cause is obvious.
  if (s[0] !== '{' && s[0] !== '[') {
    const snippet = (raw ?? '').trim().slice(0, 200) || '(empty response)';
    throw new Error(`The AI didn't return JSON — it replied: "${snippet}". Check your provider, model, and API key in Settings → AI.`);
  }
  try {
    return JSON.parse(s) as T;
  } catch {
    const snippet = (raw ?? '').trim().slice(0, 200);
    throw new Error(`The AI returned malformed JSON. It replied: "${snippet}". Try again, or switch model in Settings → AI.`);
  }
}

/** Is an AI provider usable right now (desktop + a key, or a local provider)? */
export async function hasAi(): Promise<boolean> {
  if (!(window as any).__TAURI_INTERNALS__) return false;
  const provider = (await getSetting('ai_provider', 'anthropic')) || 'anthropic';
  if (LOCAL_PROVIDERS.includes(provider)) return true;
  return !!(await getSecret('ai_api_key'));
}

/**
 * Act 4: enrich a natural-language quick-add line via AI when the deterministic
 * parser is unsure. Returns structured fields the pure `mergeQuickAdd` folds in
 * (the deterministic parse still wins where it found something).
 */
export async function quickAddParseAI(input: string, todayStr = new Date().toISOString().slice(0, 10)): Promise<QuickAddAIFields> {
  const system =
    'Extract ONE task from the user line. Return JSON: {"title": string, "deadline": "YYYY-MM-DD" or "", ' +
    '"startMin": number (minutes from midnight) or null, "durationMin": number or null, "tags": string[], ' +
    '"importance": 1-5}. Resolve relative dates ("tomorrow", "next fri") against the given today. ' +
    'title must exclude the date/time/tags you extracted.';
  const prompt = `Today is ${todayStr}. Line: "${input}"`;
  try {
    return await generateJSON<QuickAddAIFields>(system, prompt, 256);
  } catch {
    return {}; // AI unavailable / bad response → caller keeps the deterministic parse
  }
}

/** Generate and parse a JSON response. */
async function generateJSON<T>(system: string, prompt: string, maxTokens = 2048): Promise<T> {
  const text = await generate(
    system + ' Respond with ONLY valid JSON — no prose, no markdown fences.',
    prompt,
    maxTokens
  );
  return parseJSON<T>(text);
}

/** Compact, model-friendly snapshot of a task. */
function taskContext(t: {
  title: string;
  description?: string;
  tags?: string[];
  deadline?: string;
  importance: number;
  effort: number;
}): string {
  const lines = [`Title: ${t.title}`];
  if (t.description) lines.push(`Current description: ${t.description}`);
  if (t.tags?.length) lines.push(`Tags: ${t.tags.join(', ')}`);
  if (t.deadline) lines.push(`Deadline: ${t.deadline}`);
  lines.push(`Importance (1-5): ${t.importance}`);
  lines.push(`Effort (1-5): ${t.effort}`);
  return lines.join('\n');
}

/** Rewrite / expand a task description. Returns the new description text. */
export function improveDescription(task: {
  title: string;
  description?: string;
  tags?: string[];
  deadline?: string;
  importance: number;
  effort: number;
}): Promise<string> {
  const system =
    'You are a productivity assistant embedded in a task manager. ' +
    'Write clear, concise, actionable task descriptions. ' +
    'Respond with ONLY the description text — no preamble, no quotes, no markdown headers.';
  const prompt =
    `Write an improved description for this task. Keep it to 1-3 short sentences.\n\n${taskContext(task)}`;
  return generate(system, prompt);
}

/** Break a task into subtasks. Returns a newline-separated checklist string. */
export function breakIntoSubtasks(task: {
  title: string;
  description?: string;
  tags?: string[];
  deadline?: string;
  importance: number;
  effort: number;
}): Promise<string> {
  const system =
    'You are a productivity assistant embedded in a task manager. ' +
    'Break work into a small set of concrete, ordered subtasks. ' +
    'Respond with ONLY a checklist, one item per line, each starting with "- [ ] ". ' +
    'No preamble, no numbering, no extra commentary.';
  const prompt =
    `Break this task into 3-6 actionable subtasks.\n\n${taskContext(task)}`;
  return generate(system, prompt);
}

/** Suggest a priority (low / medium / high) with a one-line rationale. */
export function suggestPriority(task: {
  title: string;
  description?: string;
  tags?: string[];
  deadline?: string;
  importance: number;
  effort: number;
}): Promise<string> {
  const system =
    'You are a productivity assistant embedded in a task manager. ' +
    'Assess task priority. Respond in exactly this format on a single line: ' +
    '"<LOW|MEDIUM|HIGH> — <one short reason>". No other text.';
  const prompt =
    `Given today's date is ${new Date().toISOString().slice(0, 10)}, ` +
    `suggest a priority for this task.\n\n${taskContext(task)}`;
  return generate(system, prompt);
}

/** Summarize the whole board: what to focus on, risks, and quick wins. */
export function summarizeBoard(tasks: Task[]): Promise<string> {
  const open = tasks.filter((t) => !t.done);
  if (open.length === 0) {
    return Promise.resolve('🎉 No open tasks — your board is clear!');
  }

  const lines = open.map((t) => {
    const bits = [`• ${t.title}`];
    bits.push(`[${t.priority}]`);
    if (t.deadline) bits.push(`due ${t.deadline}`);
    if (t.tags?.length) bits.push(`#${t.tags.join(' #')}`);
    return bits.join(' ');
  });

  const system =
    'You are a productivity assistant embedded in a task manager. ' +
    'Give a brief, motivating standup-style summary of the user\'s board. ' +
    'Cover: what to focus on today, anything at risk (overdue / tight deadlines), ' +
    'and one quick win. Keep it under 120 words. Plain text, no markdown headers.';
  const prompt =
    `Today is ${new Date().toISOString().slice(0, 10)}. ` +
    `Here are the open tasks:\n\n${lines.join('\n')}`;
  return generate(system, prompt);
}

const today = () => new Date().toISOString().slice(0, 10);

/* ── Phase 2: Smart task generation ──────────────────────── */

export interface NewTaskDraft {
  title: string;
  description: string;
  tags: string[];
  deadline: string; // '' or YYYY-MM-DD
  importance: number; // 1-5
  effort: number; // 1-5
}

/** Turn a natural-language project description into a list of task drafts. */
export async function generateTasks(projectDescription: string): Promise<NewTaskDraft[]> {
  const system =
    'You are a project planner embedded in a task manager. Given a project description, ' +
    'produce a practical breakdown of up to 10 tasks. Return a JSON array where each item is ' +
    '{ "title": string, "description": string (1 sentence), "tags": string[] (lowercase, 0-3), ' +
    '"deadline": "" or "YYYY-MM-DD", "importance": 1-5, "effort": 1-5 }.';
  const prompt = `Today is ${today()}. Project:\n\n${projectDescription}`;
  const raw = await generateJSON<any[]>(system, prompt, 2048);
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((t) => ({
    title: String(t.title || '').trim(),
    description: String(t.description || '').trim(),
    tags: Array.isArray(t.tags) ? t.tags.map((x: any) => String(x).trim().toLowerCase()).filter(Boolean) : [],
    deadline: typeof t.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.deadline) ? t.deadline : '',
    importance: Math.min(5, Math.max(1, parseInt(t.importance, 10) || 3)),
    effort: Math.min(5, Math.max(1, parseInt(t.effort, 10) || 3)),
  })).filter((t) => t.title);
}

/* ── Phase 2: Auto-tagging ───────────────────────────────── */

/** Suggest up to 4 concise, lowercase tags for a task. */
export async function suggestTags(task: {
  title: string; description?: string; tags?: string[]; deadline?: string; importance: number; effort: number;
}): Promise<string[]> {
  const system =
    'You label tasks with concise, reusable tags (single lowercase words or short hyphenated phrases). ' +
    'Return a JSON array of up to 4 tag strings. No "#", no duplicates of existing tags.';
  const raw = await generateJSON<any[]>(system, taskContext(task), 256);
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => String(t).trim().toLowerCase().replace(/^#/, '')).filter(Boolean).slice(0, 4);
}

/* ── Phase 2: Predictive deadline alerts ─────────────────── */

export interface RiskItem { id: string; risk: 'low' | 'med' | 'high'; reason: string }

/** Assess which deadline-bearing open tasks are at risk, given recent velocity. */
export async function assessDeadlineRisk(
  tasks: Task[],
  stats: { weekData?: { label: string; count: number }[]; streak?: number } | null
): Promise<RiskItem[]> {
  const open = tasks.filter((t) => !t.done && t.deadline);
  if (open.length === 0) return [];
  const velocity = (stats?.weekData ?? []).map((d) => `${d.label}:${d.count}`).join(' ');
  const rows = open.map((t) =>
    `id=${t.id} | ${t.title} | due=${t.deadline} | importance=${t.importance} | effort=${t.effort} | started=${t.pomodoros_spent > 0 ? 'yes' : 'no'}`
  );
  const system =
    'You forecast deadline risk in a task manager. Using the user\'s recent completion velocity ' +
    '(tasks/day this week) and each task\'s remaining effort, days left, and whether it has been started, ' +
    'flag the at-risk ones. Return a JSON array of { "id": string, "risk": "low"|"med"|"high", "reason": string (<=12 words) }. ' +
    'Only include tasks with med or high risk.';
  const prompt = `Today is ${today()}. Weekly completions: ${velocity || 'none'}.\nTasks:\n${rows.join('\n')}`;
  const raw = await generateJSON<any[]>(system, prompt, 1024);
  if (!Array.isArray(raw)) return [];
  const ids = new Set(open.map((t) => t.id));
  return raw
    .filter((r) => r && ids.has(r.id) && (r.risk === 'med' || r.risk === 'high'))
    .map((r) => ({ id: String(r.id), risk: r.risk, reason: String(r.reason || '').trim() }));
}

/* ── Act 1: Planner advisor (duration + energy estimation) ── */

export interface SchedulingEstimate {
  id: string;
  duration_min: number;       // rounded to 15-min increments, 15–240
  energy: 'hi' | 'med' | 'lo'; // cognitive demand
}

const clampDuration = (n: number): number => {
  const v = Math.round((Number(n) || 30) / 15) * 15;
  return Math.min(240, Math.max(15, v));
};
const normEnergy = (e: any): 'hi' | 'med' | 'lo' =>
  e === 'hi' || e === 'high' ? 'hi' : e === 'lo' || e === 'low' ? 'lo' : 'med';

/**
 * Estimate how long each task will take and how much focus it demands, so the
 * planner can size blocks and match work to the user's energy curve. Returns
 * one estimate per task (best-effort; ids not understood are dropped).
 */
export async function estimateScheduling(
  tasks: { id: string; title: string; description?: string; tags?: string[]; importance: number; effort: number }[]
): Promise<SchedulingEstimate[]> {
  if (tasks.length === 0) return [];
  const rows = tasks.map((t) => {
    const bits = [`id=${t.id}`, t.title];
    if (t.tags?.length) bits.push(`#${t.tags.join(' #')}`);
    bits.push(`effort=${t.effort}`, `importance=${t.importance}`);
    return bits.join(' | ');
  });
  const system =
    'You size tasks for a daily time-block planner. For each task, estimate its ' +
    'duration in minutes (a multiple of 15, between 15 and 240) and its cognitive ' +
    'energy demand: "hi" (deep focus — best in the morning), "med", or "lo" (light / admin). ' +
    'Return a JSON array of { "id": string, "duration_min": number, "energy": "hi"|"med"|"lo" }. ' +
    'Use the effort hint (1-5) as a prior but adjust for the task itself.';
  const prompt = `Tasks:\n${rows.join('\n')}`;
  const raw = await generateJSON<any[]>(system, prompt, 1024);
  if (!Array.isArray(raw)) return [];
  const ids = new Set(tasks.map((t) => t.id));
  return raw
    .filter((r) => r && ids.has(r.id))
    .map((r) => ({ id: String(r.id), duration_min: clampDuration(r.duration_min), energy: normEnergy(r.energy) }));
}

/**
 * Chief-of-staff brief: a short, human note about the shape of the planned
 * day — what matters most, where the crunch is, and anything that slipped.
 * Desktop + API-key only (throws otherwise); deterministic plan stands alone.
 */
export function advisePlan(
  date: string,
  blocks: { title: string; start: string; end: string; reason?: string }[],
  unscheduled: string[]
): Promise<string> {
  if (blocks.length === 0 && unscheduled.length === 0) {
    return Promise.resolve('Nothing scheduled yet — hit Auto-plan and I’ll lay out your day.');
  }
  const lines = blocks.map((b) => `${b.start}–${b.end}  ${b.title}${b.reason ? `  (${b.reason})` : ''}`);
  const system =
    'You are the user’s chief of staff inside a day planner. Given their time-blocked schedule, ' +
    'write a brief, warm note (2-3 sentences, under 60 words, plain text, first person “you”). ' +
    'Name the single most important block, flag where the day is tight or anything that didn’t fit, ' +
    'and end with a nudge to start. No lists, no headers, no emoji spam.';
  const prompt =
    `Date: ${date}.\nPlanned blocks:\n${lines.join('\n') || '(none)'}\n` +
    (unscheduled.length ? `Didn’t fit: ${unscheduled.join(', ')}` : 'Everything fit.');
  return generate(system, prompt, 256);
}

/* ── Phase 2: Natural-language queries ───────────────────── */

export interface AiQuery {
  done?: boolean;
  priority?: 'low' | 'medium' | 'high';
  tag?: string;
  hasDeadline?: boolean;
  overdue?: boolean;
  dueWithinDays?: number;
  minImportance?: number;
  maxEffort?: number;
  untouched?: boolean; // not started (no pomodoros) and not done
  textIncludes?: string;
}

/** Translate a natural-language request into a structured task predicate. */
export async function queryToPredicate(nl: string, knownTags: string[]): Promise<AiQuery> {
  const system =
    'You translate a natural-language task search into a JSON predicate object. ' +
    'Allowed fields (include only those that apply): ' +
    'done (boolean), priority ("low"|"medium"|"high"), tag (string), hasDeadline (boolean), ' +
    'overdue (boolean), dueWithinDays (number), minImportance (1-5), maxEffort (1-5), ' +
    'untouched (boolean — not started and not done), textIncludes (string). ' +
    'Return {} if nothing applies.';
  const prompt = `Today is ${today()}. Known tags: ${knownTags.join(', ') || 'none'}.\nQuery: "${nl}"`;
  const q = await generateJSON<AiQuery>(system, prompt, 512);
  return q && typeof q === 'object' ? q : {};
}

/* ── Phase 2: Weekly report ──────────────────────────────── */

/** A richer weekly productivity report using real stats. */
export function weeklyReport(
  tasks: Task[],
  stats: { weekData?: { label: string; count: number }[]; done?: number; streak?: number; focusHrs?: number } | null
): Promise<string> {
  const open = tasks.filter((t) => !t.done);
  const velocity = (stats?.weekData ?? []).map((d) => `${d.label}:${d.count}`).join(' ');
  const upcoming = open
    .filter((t) => t.deadline)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 8)
    .map((t) => `• ${t.title} [${t.priority}] due ${t.deadline}`)
    .join('\n');
  const system =
    'You are a productivity coach embedded in a task manager. Write a concise weekly report: ' +
    'what got done, momentum (streak / focus hours), what is slipping, and the top 3 priorities for next week. ' +
    'Plain text with short sections, under 180 words. Encouraging but honest.';
  const prompt =
    `Today is ${today()}.\n` +
    `Completed this week (by day): ${velocity || 'none'}.\n` +
    `Total completed: ${stats?.done ?? 0}. Day streak: ${stats?.streak ?? 0}. Focus hours: ${stats?.focusHrs ?? 0}.\n` +
    `Open tasks with deadlines:\n${upcoming || 'none'}`;
  return generate(system, prompt, 1024);
}
