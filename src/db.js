/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/db.js — SQLite database abstraction layer
   Uses @tauri-apps/plugin-sql in native Tauri context,
   falls back to localStorage for browser-only testing.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
// Use native crypto.randomUUID() — available in all modern browsers & Tauri WebView
const uuid = () => crypto.randomUUID();

export function getLocalDateString(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function safeParseJSON(str, fallback) {
    if (!str) return fallback;
    try {
        return JSON.parse(str);
    } catch (e) {
        console.warn('[db.js] JSON parse error:', e.message);
        return fallback;
    }
}

// ── Detect Tauri runtime ────────────────────────────────────
export const IS_TAURI =
  typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

let _db = null;

async function db() {
    if (!IS_TAURI) return null;
    if (!_db) {
        const { default: Database } = await import('@tauri-apps/plugin-sql');
        _db = await Database.load('sqlite:cognote.db');
    }
    return _db;
}

// ── Priority scoring (M3: Rust IPC) ───────────────
export async function calcPriority(importance, effort, deadline) {
    if (IS_TAURI) {
        try {
            const { invoke } = await import('@tauri-apps/api/core');
            return await invoke('calc_priority', { importance, effort, deadline: deadline || null });
        } catch (e) {
            console.error('IPC calc_priority failed', e);
        }
    }
    // Fallback formula
    const imp = (importance / 5) * 4;
    let deadl = 0;
    if (deadline) {
        const daysLeft = Math.round(
            (new Date(deadline + 'T00:00:00') - new Date(new Date().toDateString())) / 86_400_000
        );
        deadl = daysLeft <= 0 ? 4 : daysLeft <= 14 ? 4 * (1 - daysLeft / 14) : 0;
    }
    const eff = ((6 - effort) / 5) * 2;
    const total = imp + deadl + eff;
    return total >= 6.5 ? 'high' : total >= 3.5 ? 'medium' : 'low';
}

// ── localStorage fallback ─────────────────────────────────
const LOCAL_KEY = 'cn_tasks_v2';

function localLoad() { return safeParseJSON(localStorage.getItem(LOCAL_KEY), []); }
function localSave(t) { localStorage.setItem(LOCAL_KEY, JSON.stringify(t)); }

function rowToTask(r) {
    return {
        ...r,
        done: Boolean(r.done),
        tags: Array.isArray(r.tags) ? r.tags : safeParseJSON(r.tags, []),
        pomodorosSpent: r.pomodoros_spent ?? r.pomodorosSpent ?? 0,
        pomodoros_spent: r.pomodoros_spent ?? r.pomodorosSpent ?? 0,
        createdAt: r.created_at ?? r.createdAt,
        created_at: r.created_at ?? r.createdAt ?? null,
        completedAt: r.completed_at ?? r.completedAt ?? null,
        completed_at: r.completed_at ?? r.completedAt ?? null,
        sortOrder: r.sort_order ?? r.sortOrder ?? 0,
        sort_order: r.sort_order ?? r.sortOrder ?? 0,
        // Phase 3
        project_id: r.project_id ?? r.projectId ?? null,
        parent_id: r.parent_id ?? r.parentId ?? null,
        recurrence: r.recurrence ?? 'none',
        milestone_id: r.milestone_id ?? r.milestoneId ?? null,
        custom_fields: typeof r.custom_fields === 'object' && r.custom_fields !== null
            ? r.custom_fields
            : safeParseJSON(r.custom_fields || r.customFields, {}),
        deleted_at: r.deleted_at ?? r.deletedAt ?? null,
        // Act 1: scheduling
        duration_min: r.duration_min ?? r.durationMin ?? 0,
        scheduled_start: r.scheduled_start ?? r.scheduledStart ?? null,
        scheduled_end: r.scheduled_end ?? r.scheduledEnd ?? null,
        energy: r.energy ?? 'med',
        pinned: Boolean(r.pinned),
    };
}

// ── Seed data (Cognote starter tasks) ─────────────────────────────
const today = getLocalDateString();
const tomorrow = getLocalDateString(new Date(Date.now() + 86_400_000));
const in3days = getLocalDateString(new Date(Date.now() + 3 * 86_400_000));
const in7days = getLocalDateString(new Date(Date.now() + 7 * 86_400_000));
const in10days = getLocalDateString(new Date(Date.now() + 10 * 86_400_000));

const SEED_TASKS = [
    { title: '📝 Design Cognote landing page', description: 'Create a vibrant, conversion-focused landing page for the Cognote product launch.', tags: ['design', 'marketing'], deadline: today, importance: 5, effort: 2, pomodorosSpent: 2 },
    { title: '🐛 Fix banana-peel memory leak', description: 'Profiler shows uncleaned iterators in BananaStream. Patch and benchmark.', tags: ['bug', 'perf'], deadline: tomorrow, importance: 5, effort: 4, pomodorosSpent: 3 },
    { title: '📦 Publish cognote v0.1 to crates.io', description: 'Package, tag, and publish the first public release of Cognote.', tags: ['devops', 'release'], deadline: in3days, importance: 5, effort: 2, pomodorosSpent: 1 },
    { title: '🧪 Write unit tests for Banana API', description: 'Cover all /banana/* endpoints with pytest. Aim for >90% coverage.', tags: ['backend', 'testing'], deadline: in7days, importance: 4, effort: 3, pomodorosSpent: 0 },
    { title: '📝 Write README and API docs', description: 'Document installation, quick-start, and full API reference.', tags: ['docs'], deadline: in10days, importance: 3, effort: 2, pomodorosSpent: 0 },
    { title: '✅ Set up CI/CD pipeline', description: 'GitHub Actions: lint → test → auto-publish on version tag.', tags: ['devops'], deadline: in3days, importance: 3, effort: 3, pomodorosSpent: 4, done: true },
];

async function isSeedNeeded() {
    if (!IS_TAURI) {
        return localLoad().length === 0;
    }
    const d = await db();
    const rows = await d.select("SELECT value FROM app_state WHERE key = 'seeded'");
    if (rows.length > 0) return false;
    // Double-check: if tasks already exist, mark as seeded and skip.
    const taskCount = await d.select('SELECT COUNT(*) as c FROM tasks');
    if (taskCount[0].c > 0) {
        await d.execute("INSERT OR IGNORE INTO app_state (key,value) VALUES ('seeded','1')");
        return false;
    }
    return true;
}

async function seedTasks() {
    if (!IS_TAURI) {
        // localStorage: only seed if truly empty.
        if (localLoad().length > 0) return;
    } else {
        // Tauri: set the seed flag FIRST (before inserts) so concurrent calls
        // that enter after isSeedNeeded() see it and bail out.
        const d = await db();
        const already = await d.select("SELECT value FROM app_state WHERE key = 'seeded'");
        if (already.length > 0) return;
        await d.execute("INSERT OR IGNORE INTO app_state (key,value) VALUES ('seeded','1')");
    }

    const d = await db();
    const now = new Date().toISOString();
    let order = 0;
    for (const s of SEED_TASKS) {
        const id = uuid();
        const priority = await calcPriority(s.importance, s.effort, s.deadline);
        const tags = JSON.stringify(s.tags);
        const done = s.done ? 1 : 0;
        const compAt = s.done ? now : null;
        if (IS_TAURI) {
            await d.execute(
                `INSERT OR IGNORE INTO tasks
         (id,title,description,tags,deadline,importance,effort,done,created_at,completed_at,pomodoros_spent,priority,sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [id, s.title, s.description, tags, s.deadline, s.importance, s.effort, done, now, compAt, s.pomodorosSpent ?? 0, priority, order++]
            );
        } else {
            const tasks = localLoad();
            // Skip if a task with this exact title already exists.
            if (tasks.some(t => t.title === s.title)) continue;
            tasks.push({ id, title: s.title, description: s.description, tags: s.tags, deadline: s.deadline, importance: s.importance, effort: s.effort, done: !!s.done, createdAt: now, completedAt: compAt, pomodorosSpent: s.pomodorosSpent ?? 0, priority, sortOrder: order++ });
            localSave(tasks);
        }
    }
}

// ── Settings (M4) ─────────────────────────────────────────

export async function getSetting(key, defaultValue) {
    if (!IS_TAURI) return localStorage.getItem(`cn_set_${key}`) || defaultValue;
    const d = await db();
    const rows = await d.select('SELECT value FROM app_state WHERE key=?', [key]);
    return rows.length > 0 ? rows[0].value : defaultValue;
}

export async function setSetting(key, value) {
    if (!IS_TAURI) {
        localStorage.setItem(`cn_set_${key}`, String(value));
        return;
    }
    const d = await db();
    await d.execute('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}

// ── Projects (Phase 3) ────────────────────────────────────
const LOCAL_PROJ_KEY = 'cn_projects_v1';
function localLoadProjects() { return safeParseJSON(localStorage.getItem(LOCAL_PROJ_KEY), []); }
function localSaveProjects(p) { localStorage.setItem(LOCAL_PROJ_KEY, JSON.stringify(p)); }

export async function getProjects() {
    if (!IS_TAURI) {
        return localLoadProjects().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
    const d = await db();
    return await d.select('SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC');
}

export async function createProject(name, color = '') {
    const id = uuid();
    const now = new Date().toISOString();
    if (!IS_TAURI) {
        const list = localLoadProjects();
        const proj = { id, name, color, created_at: now, sort_order: list.length };
        list.push(proj);
        localSaveProjects(list);
        return proj;
    }
    const d = await db();
    const c = await d.select('SELECT COUNT(*) as c FROM projects');
    const order = c[0].c;
    await d.execute('INSERT INTO projects (id,name,color,created_at,sort_order) VALUES (?,?,?,?,?)', [id, name, color, now, order]);
    return { id, name, color, created_at: now, sort_order: order };
}

export async function updateProject(id, data) {
    if (!IS_TAURI) {
        const list = localLoadProjects().map(p => p.id === id ? { ...p, ...data } : p);
        localSaveProjects(list);
        return;
    }
    const d = await db();
    await d.execute('UPDATE projects SET name=?, color=? WHERE id=?', [data.name, data.color ?? '', id]);
}

/**
 * Idempotently write a project row verbatim (no id generation). Used by the
 * share reconciler so a joiner gets the shared project named + grouped — the
 * "projects are a projection of the shared op-log" counterpart of upsertTaskRaw.
 */
export async function upsertProjectRaw(p) {
    const id = p.id;
    if (!id) return;
    const name = p.name ?? '';
    const color = p.color ?? '';
    if (!IS_TAURI) {
        const list = localLoadProjects();
        const i = list.findIndex(x => x.id === id);
        if (i >= 0) list[i] = { ...list[i], name, color };
        else list.push({ id, name, color, created_at: new Date().toISOString(), sort_order: list.length });
        localSaveProjects(list);
        return;
    }
    const d = await db();
    const existing = await d.select('SELECT id FROM projects WHERE id=?', [id]);
    if (existing.length > 0) {
        await d.execute('UPDATE projects SET name=?, color=? WHERE id=?', [name, color, id]);
    } else {
        const c = await d.select('SELECT COUNT(*) as c FROM projects');
        await d.execute('INSERT INTO projects (id,name,color,created_at,sort_order) VALUES (?,?,?,?,?)',
            [id, name, color, new Date().toISOString(), c[0].c]);
    }
}

export async function deleteProject(id) {
    if (!IS_TAURI) {
        localSaveProjects(localLoadProjects().filter(p => p.id !== id));
        const tasks = localLoad().map(t => t.project_id === id || t.projectId === id ? { ...t, project_id: null, projectId: null } : t);
        localSave(tasks);
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET project_id=NULL WHERE project_id=?', [id]);
    await d.execute('DELETE FROM projects WHERE id=?', [id]);
}

// ── Milestones (Phase 3) ──────────────────────────────────
const LOCAL_MILE_KEY = 'cn_milestones_v1';
function localLoadMiles() { return safeParseJSON(localStorage.getItem(LOCAL_MILE_KEY), []); }
function localSaveMiles(m) { localStorage.setItem(LOCAL_MILE_KEY, JSON.stringify(m)); }

export async function getMilestones() {
    if (!IS_TAURI) return localLoadMiles().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const d = await db();
    return await d.select('SELECT * FROM milestones ORDER BY sort_order ASC, created_at ASC');
}

export async function createMilestone(name, projectId = null, due = '') {
    const id = uuid();
    const now = new Date().toISOString();
    if (!IS_TAURI) {
        const list = localLoadMiles();
        const m = { id, project_id: projectId, name, due, created_at: now, sort_order: list.length };
        list.push(m);
        localSaveMiles(list);
        return m;
    }
    const d = await db();
    const c = await d.select('SELECT COUNT(*) as c FROM milestones');
    await d.execute('INSERT INTO milestones (id,project_id,name,due,created_at,sort_order) VALUES (?,?,?,?,?,?)', [id, projectId, name, due, now, c[0].c]);
    return { id, project_id: projectId, name, due, created_at: now, sort_order: c[0].c };
}

export async function updateMilestone(id, data) {
    if (!IS_TAURI) {
        localSaveMiles(localLoadMiles().map(m => m.id === id ? { ...m, ...data } : m));
        return;
    }
    const d = await db();
    await d.execute('UPDATE milestones SET name=?, due=?, project_id=? WHERE id=?', [data.name, data.due ?? '', data.project_id ?? null, id]);
}

export async function deleteMilestone(id) {
    if (!IS_TAURI) {
        localSaveMiles(localLoadMiles().filter(m => m.id !== id));
        localSave(localLoad().map(t => (t.milestone_id === id || t.milestoneId === id) ? { ...t, milestone_id: null, milestoneId: null } : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET milestone_id=NULL WHERE milestone_id=?', [id]);
    await d.execute('DELETE FROM milestones WHERE id=?', [id]);
}

// ── Templates (Phase 3) ───────────────────────────────────
const LOCAL_TPL_KEY = 'cn_templates_v1';
function localLoadTpls() { return safeParseJSON(localStorage.getItem(LOCAL_TPL_KEY), []); }
function localSaveTpls(t) { localStorage.setItem(LOCAL_TPL_KEY, JSON.stringify(t)); }

export async function getTemplates() {
    if (!IS_TAURI) return localLoadTpls();
    const d = await db();
    const rows = await d.select('SELECT * FROM templates ORDER BY created_at DESC');
    return rows.map(r => ({ ...r, data: safeParseJSON(r.data, {}) }));
}

export async function createTemplate(name, data) {
    const id = uuid();
    const now = new Date().toISOString();
    if (!IS_TAURI) {
        const list = localLoadTpls();
        list.unshift({ id, name, data, created_at: now });
        localSaveTpls(list);
        return { id, name, data, created_at: now };
    }
    const d = await db();
    await d.execute('INSERT INTO templates (id,name,data,created_at) VALUES (?,?,?,?)', [id, name, JSON.stringify(data), now]);
    return { id, name, data, created_at: now };
}

export async function deleteTemplate(id) {
    if (!IS_TAURI) { localSaveTpls(localLoadTpls().filter(t => t.id !== id)); return; }
    const d = await db();
    await d.execute('DELETE FROM templates WHERE id=?', [id]);
}

// ── CRUD ──────────────────────────────────────────────────

let _initPromise = null;
export async function initDb() {
    // Single-flight: concurrent callers (e.g. multiple loadAllTasks, or React
    // StrictMode double-invoking effects in dev) must share ONE init, or the
    // seed-needed check races and the demo tasks get inserted twice.
    if (!_initPromise) {
        _initPromise = (async () => {
            if (await isSeedNeeded()) await seedTasks();
            // Heal duplicates left by the historical double-seed. Runs once per
            // launch (this init is single-flight), so it's self-correcting — not
            // gated behind a flag that could get stuck set.
            try {
                const n = await dedupeTasks();
                if (n > 0) console.info(`[db.js] removed ${n} duplicate task(s)`);
            } catch (e) {
                console.warn('[db.js] dedupe failed:', e);
            }
        })().catch((e) => {
            _initPromise = null; // let a failed init be retried
            throw e;
        });
    }
    return _initPromise;
}

/**
 * Fold the write-ahead log back into the main DB file and empty it, so a
 * plain file copy of `cognote.db` is a consistent snapshot. No-op off Tauri.
 */
export async function checkpoint() {
    if (!IS_TAURI) return;
    try {
        const d = await db();
        await d.execute('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {
        console.warn('[db.js] checkpoint failed:', e);
    }
}

/**
 * Run SQLite's own consistency checks. Returns 'ok' when healthy, otherwise a
 * short description of the first problem found. Off Tauri there is no SQLite,
 * so we report healthy.
 */
export async function integrityCheck() {
    if (!IS_TAURI) return 'ok';
    const d = await db();
    const rows = await d.select('PRAGMA integrity_check');
    const first = rows?.[0]?.integrity_check ?? rows?.[0]?.['integrity_check'];
    if (first && first !== 'ok') return String(first);
    const fk = await d.select('PRAGMA foreign_key_check');
    if (Array.isArray(fk) && fk.length > 0) return `foreign key violations: ${fk.length}`;
    return 'ok';
}

export async function getAllTasks(filter = 'all') {
    if (!IS_TAURI) {
        let tasks = localLoad().map(rowToTask);
        // Trash view: only soft-deleted tasks, newest-deleted first.
        if (filter === 'trash') {
            return tasks
                .filter(t => t.deleted_at)
                .sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
        }
        // Every other view excludes soft-deleted tasks.
        tasks = tasks.filter(t => !t.deleted_at);
        const todayStr = getLocalDateString();
        if (filter === 'today') tasks = tasks.filter(t => t.deadline === todayStr);
        if (filter === 'high') tasks = tasks.filter(t => t.priority === 'high' && !t.done);
        // M5: tag filter support
        if (filter.startsWith('tag:')) {
            const tag = filter.split(':')[1];
            tasks = tasks.filter(t => (t.tags || []).includes(tag));
        }
        if (filter.startsWith('project:')) {
            const pid = filter.slice('project:'.length);
            tasks = tasks.filter(t => (t.project_id ?? t.projectId) === pid);
        }
        if (filter.startsWith('milestone:')) {
            const mid = filter.slice('milestone:'.length);
            tasks = tasks.filter(t => (t.milestone_id ?? t.milestoneId) === mid);
        }
        return tasks.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    }
    const d = await db();
    const todayStr = getLocalDateString();

    // Trash view: only soft-deleted tasks, newest-deleted first.
    if (filter === 'trash') {
        const rows = await d.select('SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
        return rows.map(rowToTask);
    }

    // S4: Parameterized queries. Every live view filters out soft-deleted rows.
    if (filter === 'today') {
        const rows = await d.select('SELECT * FROM tasks WHERE deadline = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at DESC', [todayStr]);
        return rows.map(rowToTask);
    }
    if (filter === 'high') {
        const rows = await d.select('SELECT * FROM tasks WHERE priority = ? AND done = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at DESC', ['high', 0]);
        return rows.map(rowToTask);
    }
    if (filter.startsWith('tag:')) {
        const tag = filter.split(':')[1];
        // JSON1 function exists in SQLite 3.38+
        const rows = await d.select("SELECT * FROM tasks WHERE deleted_at IS NULL AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?) ORDER BY sort_order ASC, created_at DESC", [tag]);
        return rows.map(rowToTask);
    }
    if (filter.startsWith('project:')) {
        const pid = filter.slice('project:'.length);
        const rows = await d.select('SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at DESC', [pid]);
        return rows.map(rowToTask);
    }
    if (filter.startsWith('milestone:')) {
        const mid = filter.slice('milestone:'.length);
        const rows = await d.select('SELECT * FROM tasks WHERE milestone_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC, created_at DESC', [mid]);
        return rows.map(rowToTask);
    }

    const rows = await d.select('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at DESC');
    return rows.map(rowToTask);
}

/**
 * Decide which tasks are exact duplicates and should be removed. Pure +
 * exported for testing. Groups live (non-trashed) tasks by their defining
 * fields; within a group keeps the most "advanced" copy (done > started >
 * scheduled > earliest) and returns the ids of the rest. Distinct tasks and
 * anything in Trash are never touched.
 */
export function planDedupe(tasks) {
    const groups = new Map();
    for (const t of tasks) {
        if (t.deleted_at) continue; // never touch Trash
        // Group by the defining fields. Seed duplicates share these exactly;
        // genuinely-distinct tasks differ in at least one, so they're never merged.
        const key = [t.title, t.description, t.deadline, t.parent_id ?? '', t.recurrence ?? 'none'].join('\u0000');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
    }
    const score = (t) => (t.done ? 1000 : 0) + (t.pomodoros_spent ?? 0) * 10 + (t.scheduled_start ? 5 : 0);
    const removeIds = new Set();
    for (const group of groups.values()) {
        if (group.length < 2) continue; // not a duplicate
        const keeper = group.reduce((best, t) => {
            const d = score(t) - score(best);
            if (d > 0) return t;
            if (d < 0) return best;
            return String(t.created_at) < String(best.created_at) ? t : best; // tie -> earliest
        });
        for (const t of group) if (t.id !== keeper.id) removeIds.add(t.id);
    }
    return removeIds;
}

/** Remove exact-duplicate tasks left behind by the historical double-seed. Returns the count removed. */
export async function dedupeTasks() {
    if (!IS_TAURI) {
        const raw = localLoad();
        const removeIds = planDedupe(raw.map(rowToTask));
        if (removeIds.size === 0) return 0;
        localSave(raw.filter(t => !removeIds.has(t.id)));
        return removeIds.size;
    }
    const d = await db();
    const rows = (await d.select('SELECT * FROM tasks')).map(rowToTask);
    const removeIds = planDedupe(rows);
    for (const id of removeIds) await d.execute('DELETE FROM tasks WHERE id=?', [id]);
    return removeIds.size;
}

export async function createTask(data) {
    const id = uuid();
    const priority = await calcPriority(data.importance, data.effort, data.deadline);
    const now = new Date().toISOString();
    const tags = data.tags || [];
    const projectId = data.project_id ?? null;
    const parentId = data.parent_id ?? null;
    const recurrence = data.recurrence ?? 'none';
    const milestoneId = data.milestone_id ?? null;
    const customFields = data.custom_fields ?? {};
    const task = {
        id, ...data, tags, done: false, createdAt: now, created_at: now,
        completedAt: null, completed_at: null, pomodorosSpent: 0, pomodoros_spent: 0,
        priority, sortOrder: 0, sort_order: 0,
        project_id: projectId, projectId, parent_id: parentId, parentId, recurrence,
        milestone_id: milestoneId, custom_fields: customFields,
        // Act 1: scheduling defaults
        duration_min: data.duration_min ?? 0, energy: data.energy ?? 'med', pinned: false,
        scheduled_start: null, scheduled_end: null,
    };

    if (!IS_TAURI) {
        const tasks = localLoad();
        task.sortOrder = tasks.length;
        task.sort_order = tasks.length;
        tasks.push(task);
        localSave(tasks);
        return task;
    }
    const d = await db();
    const allRows = await d.select('SELECT COUNT(*) as c FROM tasks');
    task.sortOrder = allRows[0].c;
    task.sort_order = allRows[0].c;
    await d.execute(
        `INSERT INTO tasks (id,title,description,tags,deadline,importance,effort,done,created_at,completed_at,pomodoros_spent,priority,sort_order,project_id,parent_id,recurrence,milestone_id,custom_fields)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, task.title, task.description, JSON.stringify(tags), task.deadline, task.importance, task.effort, 0, now, null, 0, priority, task.sortOrder, projectId, parentId, recurrence, milestoneId, JSON.stringify(customFields)]
    );
    return task;
}

/**
 * Write a full task row verbatim (no priority recompute, no id generation).
 * The reconciler uses this to make SQLite match the op-log projection — the
 * "SQLite is a projection" mechanism (Act 2). Idempotent via INSERT OR REPLACE.
 */
export async function upsertTaskRaw(t) {
    const tags = Array.isArray(t.tags) ? t.tags : safeParseJSON(t.tags, []);
    const cf = (typeof t.custom_fields === 'object' && t.custom_fields !== null) ? t.custom_fields : safeParseJSON(t.custom_fields, {});
    const row = {
        id: t.id,
        title: t.title ?? '', description: t.description ?? '', deadline: t.deadline ?? '',
        importance: t.importance ?? 3, effort: t.effort ?? 3, done: t.done ? 1 : 0,
        created_at: t.created_at ?? null, completed_at: t.completed_at ?? null,
        pomodoros_spent: t.pomodoros_spent ?? 0, priority: t.priority ?? 'medium', sort_order: t.sort_order ?? 0,
        project_id: t.project_id ?? null, parent_id: t.parent_id ?? null, recurrence: t.recurrence ?? 'none',
        milestone_id: t.milestone_id ?? null, deleted_at: t.deleted_at ?? null,
        duration_min: t.duration_min ?? 0, scheduled_start: t.scheduled_start ?? null,
        scheduled_end: t.scheduled_end ?? null, energy: t.energy ?? 'med', pinned: t.pinned ? 1 : 0,
    };
    if (!IS_TAURI) {
        const tasks = localLoad();
        const i = tasks.findIndex(x => x.id === t.id);
        const merged = { ...row, done: !!t.done, pinned: !!t.pinned, tags, custom_fields: cf };
        if (i >= 0) tasks[i] = { ...tasks[i], ...merged };
        else tasks.push(merged);
        localSave(tasks);
        return;
    }
    const d = await db();
    await d.execute(
        `INSERT OR REPLACE INTO tasks
         (id,title,description,tags,deadline,importance,effort,done,created_at,completed_at,pomodoros_spent,priority,sort_order,project_id,parent_id,recurrence,milestone_id,custom_fields,deleted_at,duration_min,scheduled_start,scheduled_end,energy,pinned)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.id, row.title, row.description, JSON.stringify(tags), row.deadline, row.importance, row.effort, row.done,
         row.created_at, row.completed_at, row.pomodoros_spent, row.priority, row.sort_order, row.project_id, row.parent_id,
         row.recurrence, row.milestone_id, JSON.stringify(cf), row.deleted_at, row.duration_min, row.scheduled_start,
         row.scheduled_end, row.energy, row.pinned]
    );
}

export async function updateTask(id, data) {
    const priority = await calcPriority(data.importance, data.effort, data.deadline);
    const tags = Array.isArray(data.tags) ? data.tags : (data.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    const projectId = data.project_id ?? null;
    const recurrence = data.recurrence ?? 'none';
    const milestoneId = data.milestone_id ?? null;
    const customFields = data.custom_fields ?? {};

    if (!IS_TAURI) {
        const tasks = localLoad().map(t => t.id === id
            ? { ...t, ...data, tags, priority, project_id: projectId, projectId, recurrence, milestone_id: milestoneId, custom_fields: customFields }
            : t);
        localSave(tasks);
        return rowToTask(tasks.find(t => t.id === id));
    }
    const d = await db();
    await d.execute(
        `UPDATE tasks SET title=?,description=?,tags=?,deadline=?,importance=?,effort=?,priority=?,project_id=?,recurrence=?,milestone_id=?,custom_fields=? WHERE id=?`,
        [data.title, data.description, JSON.stringify(tags), data.deadline, data.importance, data.effort, priority, projectId, recurrence, milestoneId, JSON.stringify(customFields), id]
    );
    const rows = await d.select('SELECT * FROM tasks WHERE id=?', [id]);
    return rowToTask(rows[0]);
}

/** Soft-delete: stamp deleted_at so the task drops out of every live view but stays recoverable. */
export async function softDeleteTask(id, when = new Date().toISOString()) {
    if (!IS_TAURI) {
        localSave(localLoad().map(t => t.id === id ? { ...t, deleted_at: when, deletedAt: when } : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET deleted_at=? WHERE id=?', [when, id]);
}

/** Restore a soft-deleted task by clearing its deleted_at stamp. */
export async function restoreTask(id) {
    if (!IS_TAURI) {
        localSave(localLoad().map(t => t.id === id ? { ...t, deleted_at: null, deletedAt: null } : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET deleted_at=NULL WHERE id=?', [id]);
}

/** Return only the soft-deleted tasks (the Trash), newest-deleted first. */
export async function getTrash() {
    return getAllTasks('trash');
}

/** Permanently remove a single task (purge from Trash). */
export async function deleteTask(id) {
    if (!IS_TAURI) {
        localSave(localLoad().filter(t => t.id !== id));
        return;
    }
    const d = await db();
    await d.execute('DELETE FROM tasks WHERE id=?', [id]);
}

/** Permanently remove every soft-deleted task. Returns the count purged. */
export async function emptyTrash() {
    if (!IS_TAURI) {
        const all = localLoad();
        const kept = all.filter(t => !t.deleted_at && !t.deletedAt);
        localSave(kept);
        return all.length - kept.length;
    }
    const d = await db();
    const before = await d.select('SELECT COUNT(*) as c FROM tasks WHERE deleted_at IS NOT NULL');
    await d.execute('DELETE FROM tasks WHERE deleted_at IS NOT NULL');
    return before[0]?.c ?? 0;
}

export async function toggleTask(id) {
    if (!IS_TAURI) {
        const tasks = localLoad();
        const t = tasks.find(t => t.id === id);
        t.done = !t.done;
        t.completedAt = t.done ? new Date().toISOString() : null;
        localSave(tasks);
        return rowToTask(t);
    }
    const d = await db();
    const rows = await d.select('SELECT done FROM tasks WHERE id=?', [id]);
    const newDone = rows[0].done === 0 ? 1 : 0;
    const completedAt = newDone ? new Date().toISOString() : null;
    await d.execute('UPDATE tasks SET done=?,completed_at=? WHERE id=?', [newDone, completedAt, id]);
    const updated = await d.select('SELECT * FROM tasks WHERE id=?', [id]);
    return rowToTask(updated[0]);
}

// DnD persistence (S2)
export async function updateSortOrders(orderedIds) {
    if (!IS_TAURI) {
        let tasks = localLoad();
        tasks.forEach(t => {
            const idx = orderedIds.indexOf(t.id);
            if (idx >= 0) t.sortOrder = idx;
        });
        localSave(tasks);
        return;
    }
    const d = await db();
    
    // Batch update utilizing fully parameterized queries to prevent SQL injection
    if (orderedIds.length === 0) return;
    
    const caseSnippets = orderedIds.map(() => `WHEN ? THEN ?`).join(' ');
    const idList = orderedIds.map(() => '?').join(',');
    
    // Build arguments: [id1, order1, id2, order2, ..., id1, id2, ...]
    const args = [];
    orderedIds.forEach((id, index) => {
        args.push(id, index);
    });
    orderedIds.forEach(id => {
        args.push(id);
    });
    
    const query = `
        UPDATE tasks 
        SET sort_order = CASE id 
            ${caseSnippets} 
            ELSE sort_order 
        END 
        WHERE id IN (${idList})
    `;
    
    try {
        await d.execute(query, args);
    } catch (err) {
        console.error('Failed to batch update sort orders', err);
    }
}

export async function addPomodoro(id) {
    if (!IS_TAURI) {
        const tasks = localLoad().map(t => t.id === id ? { ...t, pomodorosSpent: (t.pomodorosSpent || 0) + 1 } : t);
        localSave(tasks);
        return rowToTask(tasks.find(t => t.id === id));
    }
    const d = await db();
    await d.execute('UPDATE tasks SET pomodoros_spent = pomodoros_spent + 1 WHERE id=?', [id]);
    const rows = await d.select('SELECT * FROM tasks WHERE id=?', [id]);
    return rowToTask(rows[0]);
}

// ── Scheduling & Calendar (Act 1: Planner) ────────────────

/** Persist a planner-assigned time block (ISO datetimes) onto a task. */
export async function setSchedule(id, start, end) {
    if (!IS_TAURI) {
        localSave(localLoad().map(t => t.id === id
            ? { ...t, scheduled_start: start, scheduled_end: end, scheduledStart: start, scheduledEnd: end }
            : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET scheduled_start=?, scheduled_end=? WHERE id=?', [start, end, id]);
}

/** Pin/unpin a task to its scheduled slot (the planner won't re-flow a pin). */
export async function setPinned(id, pinned) {
    if (!IS_TAURI) {
        localSave(localLoad().map(t => t.id === id ? { ...t, pinned: !!pinned } : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET pinned=? WHERE id=?', [pinned ? 1 : 0, id]);
}

/**
 * Clear scheduled blocks for a given date before a re-plan. Skips pinned tasks
 * (the user fixed those) and completed tasks (done work stays on the timeline as
 * a record — the planner never re-flows it).
 */
export async function clearDaySchedules(date) {
    if (!IS_TAURI) {
        localSave(localLoad().map(t => {
            const s = t.scheduled_start ?? t.scheduledStart;
            const pinned = t.pinned || t.pinned === 1;
            const done = t.done || t.done === 1;
            if (!pinned && !done && s && String(s).slice(0, 10) === date) {
                return { ...t, scheduled_start: null, scheduled_end: null, scheduledStart: null, scheduledEnd: null };
            }
            return t;
        }));
        return;
    }
    const d = await db();
    await d.execute(
        "UPDATE tasks SET scheduled_start=NULL, scheduled_end=NULL WHERE pinned=0 AND done=0 AND scheduled_start IS NOT NULL AND substr(scheduled_start,1,10)=?",
        [date]
    );
}

/** Update a task's scheduling attributes (duration, energy, pinned). */
export async function updateScheduling(id, fields) {
    const dur = fields.duration_min ?? 0;
    const energy = fields.energy ?? 'med';
    const pinned = fields.pinned ? 1 : 0;
    if (!IS_TAURI) {
        localSave(localLoad().map(t => t.id === id
            ? { ...t, duration_min: dur, energy, pinned: !!fields.pinned }
            : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET duration_min=?, energy=?, pinned=? WHERE id=?', [dur, energy, pinned, id]);
}

const LOCAL_CAL_KEY = 'cn_calevents_v1';
function localLoadCal() { return safeParseJSON(localStorage.getItem(LOCAL_CAL_KEY), []); }
function localSaveCal(e) { localStorage.setItem(LOCAL_CAL_KEY, JSON.stringify(e)); }

export async function getCalendarEvents() {
    if (!IS_TAURI) return localLoadCal().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const d = await db();
    return await d.select('SELECT * FROM calendar_events ORDER BY start ASC');
}

export async function createCalendarEvent({ title = '', start, end, source = 'manual' }) {
    const id = uuid();
    const now = new Date().toISOString();
    const ev = { id, title, start, end, source, created_at: now };
    if (!IS_TAURI) {
        const list = localLoadCal();
        list.push(ev);
        localSaveCal(list);
        return ev;
    }
    const d = await db();
    await d.execute(
        'INSERT INTO calendar_events (id,title,start,end,source,created_at) VALUES (?,?,?,?,?,?)',
        [id, title, start, end, source, now]
    );
    return ev;
}

export async function deleteCalendarEvent(id) {
    if (!IS_TAURI) { localSaveCal(localLoadCal().filter(e => e.id !== id)); return; }
    const d = await db();
    await d.execute('DELETE FROM calendar_events WHERE id=?', [id]);
}

/** Remove all calendar events from a given source (e.g. refreshing an .ics feed). */
export async function clearCalendarSource(source) {
    if (!IS_TAURI) { localSaveCal(localLoadCal().filter(e => e.source !== source)); return; }
    const d = await db();
    await d.execute('DELETE FROM calendar_events WHERE source=?', [source]);
}

// ── CRDT op-log (Act 2: Sync Spine) ───────────────────────
// Append-only operation store. Persisted as the future source of truth;
// today it shadows the SQLite tables so we can prove convergence first.

const LOCAL_OPLOG_KEY = 'cn_oplog_v1';
function localLoadOps() { return safeParseJSON(localStorage.getItem(LOCAL_OPLOG_KEY), []); }
function localSaveOps(ops) { localStorage.setItem(LOCAL_OPLOG_KEY, JSON.stringify(ops)); }

/** Load the full op-log, oldest first. Each row is rehydrated to an `Op`. */
export async function loadOps() {
    if (!IS_TAURI) return localLoadOps();
    const d = await db();
    const rows = await d.select('SELECT * FROM oplog ORDER BY wall ASC, counter ASC, actor ASC');
    return rows.map(r => r.kind === 'del'
        ? { id: r.id, hlc: { wall: r.wall, counter: r.counter, actor: r.actor }, kind: 'del', entity: r.entity }
        : { id: r.id, hlc: { wall: r.wall, counter: r.counter, actor: r.actor }, kind: 'set', entity: r.entity, field: r.field, value: safeParseJSON(r.value, null) });
}

/** Append ops, ignoring any whose id already exists (idempotent merge). */
export async function appendOps(ops) {
    if (!ops || ops.length === 0) return;
    if (!IS_TAURI) {
        const seen = new Set(localLoadOps().map(o => o.id));
        const next = localLoadOps();
        for (const o of ops) if (!seen.has(o.id)) { next.push(o); seen.add(o.id); }
        localSaveOps(next);
        return;
    }
    const d = await db();
    for (const o of ops) {
        await d.execute(
            'INSERT OR IGNORE INTO oplog (id,wall,counter,actor,kind,entity,field,value) VALUES (?,?,?,?,?,?,?,?)',
            [o.id, o.hlc.wall, o.hlc.counter, o.hlc.actor, o.kind, o.entity,
             o.kind === 'set' ? o.field : null,
             o.kind === 'set' ? JSON.stringify(o.value) : null]
        );
    }
}

// M2: Aggregated SQL getStats
export async function getStats() {
    const today = getLocalDateString();
    let s = { total: 0, done: 0, urgent: 0, pomos: 0, high: 0, medium: 0, low: 0, todayCount: 0, highPending: 0 };
    let completedDates = [];

    if (!IS_TAURI) {
        const tasks = localLoad().map(rowToTask).filter(t => !t.deleted_at);
        s.total = tasks.length;
        s.done = tasks.filter(t => t.done).length;
        s.urgent = tasks.filter(t => t.priority === 'high' && !t.done).length;
        s.pomos = tasks.reduce((sum, t) => sum + (t.pomodorosSpent || 0), 0);
        s.high = tasks.filter(t => t.priority === 'high').length;
        s.medium = tasks.filter(t => t.priority === 'medium').length;
        s.low = tasks.filter(t => t.priority === 'low').length;
        s.todayCount = tasks.filter(t => t.deadline === today).length;
        s.highPending = s.urgent;
        completedDates = tasks.filter(t => t.completedAt).map(t => getLocalDateString(new Date(t.completedAt)));
    } else {
        const d = await db();
        // Aggregated query
        const q = `
            SELECT
                COUNT(*) as total,
                SUM(done) as done_count,
                SUM(CASE WHEN priority='high' AND done=0 THEN 1 ELSE 0 END) as urgent,
                SUM(pomodoros_spent) as pomos,
                SUM(CASE WHEN priority='high' THEN 1 ELSE 0 END) as high,
                SUM(CASE WHEN priority='medium' THEN 1 ELSE 0 END) as medium,
                SUM(CASE WHEN priority='low' THEN 1 ELSE 0 END) as low,
                SUM(CASE WHEN deadline=? THEN 1 ELSE 0 END) as todayCount
            FROM tasks
            WHERE deleted_at IS NULL
        `;
        const aggRes = await d.select(q, [today]);
        if (aggRes.length > 0) {
            const r = aggRes[0];
            s.total = r.total;
            s.done = r.done_count || 0;
            s.urgent = r.urgent || 0;
            s.pomos = r.pomos || 0;
            s.high = r.high || 0;
            s.medium = r.medium || 0;
            s.low = r.low || 0;
            s.todayCount = r.todayCount || 0;
            s.highPending = s.urgent;
        }

        // Minimal query for streak
        const datesRes = await d.select('SELECT completed_at FROM tasks WHERE completed_at IS NOT NULL AND deleted_at IS NULL');
        completedDates = datesRes.map(r => getLocalDateString(new Date(r.completed_at)));
    }

    const focusHrs = parseFloat((s.pomos * 25 / 60).toFixed(1));

    // Streak logic
    const completedSet = new Set(completedDates);
    let streak = 0, checkDay = new Date();
    while (completedSet.has(getLocalDateString(checkDay))) {
        streak++;
        checkDay.setDate(checkDay.getDate() - 1);
    }

    // Week chart data
    const weekData = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date(Date.now() - i * 86_400_000);
        const key = getLocalDateString(date);
        weekData.push({
            label: date.toLocaleDateString('en', { weekday: 'short' }),
            count: completedDates.filter(d => d === key).length
        });
    }

    return { ...s, focusHrs, streak, weekData };
}
