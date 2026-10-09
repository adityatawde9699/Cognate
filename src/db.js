import {encryptBrowserSecret,isEncryptedSecret} from './utils/browserVault';
import { readBrowserWorkspace, patchBrowserWorkspace } from './services/browserStorage';
import { merge, Clock, hlcCompare, entityToOps, delOp, canonicalJson } from './services/oplog';
import { nextDeadline, recurrenceId } from './services/recurrenceRules';
import { planInputKey } from './services/planReview';
import { taskRecord } from './services/taskFields';
/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/db.js — SQLite database abstraction layer
   Uses @tauri-apps/plugin-sql in native Tauri context,
   uses transactional IndexedDB in browsers; Node unit tests use a memory/localStorage shim.
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
let _dbLoading = null;
let maintenance = false;
const activeCalls = new Set();

function guardedCall(connection, method, args) {
    if (maintenance) return Promise.reject(new Error('Database restore in progress. Please wait for reload.'));
    const call = Promise.resolve().then(() => connection[method](...args));
    activeCalls.add(call);
    call.then(() => activeCalls.delete(call), () => activeCalls.delete(call));
    return call;
}

async function db() {
    if (!IS_TAURI) return null;
    if (maintenance) throw new Error('Database restore in progress. Please wait for reload.');
    if (!_dbLoading) {
        _dbLoading = (async () => {
            const { default: Database } = await import('@tauri-apps/plugin-sql');
            const connection = await Database.load('sqlite:cognote.db');
            _db = {
                execute: (...args) => {
                    if (/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:tasks|projects)\b/i.test(args[0])) {
                        return guardedCall({ execute: async () => {
                            const { invoke } = await import('@tauri-apps/api/core');
                            return invoke('mutate_tasks', { query: args[0], values: args[1] ?? [] });
                        } }, 'execute', []);
                    }
                    return guardedCall(connection, 'execute', args);
                },
                batch: (statements) => guardedCall({ execute: async () => {
                    const { invoke } = await import('@tauri-apps/api/core');
                    return invoke('mutate_entity_batch', { statements });
                } }, 'execute', []),
                select: (...args) => guardedCall(connection, 'select', args),
                close: () => connection.close('sqlite:cognote.db'),
            };
            return _db;
        })().catch(error => { _dbLoading = null; throw error; });
    }
    return _dbLoading;
}

/** Drain adapter calls and close the native pool. A successful restore keeps
 * access blocked until reload so stale UI/sync state cannot write over it. */
export async function runDatabaseMaintenance(action, freezeAfterSuccess = false) {
    if (maintenance) throw new Error('Database maintenance is already in progress.');
    maintenance = true;
    let completed = false;
    try {
        if (_dbLoading) await _dbLoading;
        await Promise.allSettled([...activeCalls]);
        if (_db) await _db.close();
        _db = null;
        _dbLoading = null;
        _initPromise = null;
        const result = await action();
        completed = true;
        return result;
    } finally {
        if (!completed || !freezeAfterSuccess) maintenance = false;
    }
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

const ATOMIC_WORKSPACE_KEY = 'cn_atomic_workspace_v1';
let browserSnapshot = null;
const USE_INDEXED_DB = !IS_TAURI && typeof window !== 'undefined';
function legacyWorkspace() {
    const raw = localStorage.getItem(ATOMIC_WORKSPACE_KEY);
    const settings = {};
    if (USE_INDEXED_DB) for (let i=0;i<localStorage.length;i++) {
        const key = localStorage.key(i);
        if (key?.startsWith('cn_set_')) settings[key.slice(7)] = localStorage.getItem(key) ?? '';
    }
    const extra = {
        settings, calendar_events: JSON.parse(localStorage.getItem('cn_calevents_v1') ?? '[]'),
        milestones: JSON.parse(localStorage.getItem('cn_milestones_v1') ?? '[]'),
        templates: JSON.parse(localStorage.getItem('cn_templates_v1') ?? '[]'),
    };
    if (raw) {
        const state = JSON.parse(raw);
        if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.ops)) throw new Error('Damaged legacy workspace.');
        return { ...extra, ...state, projects: state.projects ?? JSON.parse(localStorage.getItem('cn_projects_v1') ?? '[]') };
    }
    return { ...extra, version: 1,
        tasks: JSON.parse(localStorage.getItem('cn_tasks_v2') ?? '[]'),
        ops: JSON.parse(localStorage.getItem('cn_oplog_v1') ?? '[]'),
        projects: JSON.parse(localStorage.getItem('cn_projects_v1') ?? '[]'),
        actor: localStorage.getItem('cn_set_crdt_actor') || uuid(),
    };
}
async function ensureBrowserStorage() {
    if (USE_INDEXED_DB) rememberBrowserSnapshot(await readBrowserWorkspace(legacyWorkspace));
}

function rememberBrowserSnapshot(snapshot) {
    if (!browserSnapshot || snapshot.revision >= browserSnapshot.revision) browserSnapshot = snapshot;
}
async function patchBrowser(patch) {
    if (maintenance) throw new Error('Database maintenance in progress.');
    rememberBrowserSnapshot(await patchBrowserWorkspace(patch));
}
function workspace() {
    if (USE_INDEXED_DB) return browserSnapshot ? structuredClone(browserSnapshot.state) : null;
    const raw = localStorage.getItem(ATOMIC_WORKSPACE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw); // Never reset corrupt storage to an empty workspace.
    if (value.version !== 1 || !Array.isArray(value.tasks) || !Array.isArray(value.ops)) throw new Error('Unsupported or damaged workspace storage.');
    return value;
}
function localLoad() { return workspace()?.tasks ?? safeParseJSON(localStorage.getItem(LOCAL_KEY), []); }
async function commitWorkspace(tasks, ops, actor, projects = localLoadProjects(), extra = {}) {
    if (maintenance) throw new Error('Database maintenance in progress.');
    const previous = workspace();
    const clock = new Clock(actor, Date.now());
    if (previous?.hlc) clock.receive(previous.hlc);
    for (const op of ops) if (hlcCompare(op.hlc,clock.current()) >= 0) clock.receive(op.hlc);
    const hlc = clock.current();
    const state = { ...previous, ...extra, version: 1, tasks, projects, ops, actor, hlc };
    if (USE_INDEXED_DB) {
        if (!previous) throw new Error('Browser storage is not initialized.');
        await patchBrowser(current => {
            for (const field of ['tasks','projects','ops','actor',...Object.keys(extra)]) {
                if (canonicalJson(current[field] ?? null) !== canonicalJson(previous[field] ?? null)) {
                    throw new Error('Workspace changed in another tab. Reload and retry your change.');
                }
            }
            Object.assign(current,{...extra,tasks,projects,ops,actor,hlc});
        });
    } else localStorage.setItem(ATOMIC_WORKSPACE_KEY, JSON.stringify(state));
}
async function localSave(tasks, projects = localLoadProjects(), extra = {}) {
    const previous = localLoad().map(rowToTask);
    const ops = localLoadOps();
    const actor = workspace()?.actor || localStorage.getItem('cn_set_crdt_actor') || uuid();
    const clock = new Clock(actor, Date.now());
    if (workspace()?.hlc) clock.receive(workspace().hlc);
    for (const op of ops) if (hlcCompare(op.hlc, clock.current()) >= 0) clock.receive(op.hlc);
    const before = new Map(previous.map(t => [t.id, taskRecord(t)]));
    const after = new Map(tasks.map(rowToTask).map(t => [t.id, taskRecord(t)]));
    const generated = [];
    for (const [id, fields] of after) {
        const old = before.get(id);
        if (!old || canonicalJson(old) !== canonicalJson(fields)) generated.push(...entityToOps(clock, id, fields));
    }
    for (const id of before.keys()) if (!after.has(id)) generated.push(delOp(clock, id));
    const projectBefore = new Map(localLoadProjects().map(project => [project.id, project]));
    const projectAfter = new Map(projects.map(project => [project.id, project]));
    for (const [id, project] of projectAfter) {
        if (canonicalJson(projectBefore.get(id) ?? null) !== canonicalJson(project)) {
            const { id: ignored, ...fields } = project;
            generated.push(...entityToOps(clock, `project:${id}`, fields));
        }
    }
    for (const id of projectBefore.keys()) if (!projectAfter.has(id)) generated.push(delOp(clock, `project:${id}`));
    await commitWorkspace(tasks, merge(ops, generated), actor, projects, extra);
}

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
    // Sample data is a development fixture. Production onboarding creates
    // starter tasks only when explicitly selected by the user.
    if(!import.meta.env.DEV) return false;
    if (!IS_TAURI) {
        return localLoad().length === 0 && await getSetting('seeded','')!=='1';
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
            await localSave(tasks);
        }
    }
    if(!IS_TAURI) await setSetting('seeded','1');
}

// ── Settings (M4) ─────────────────────────────────────────

export async function getSetting(key, defaultValue) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI && key === 'crdt_actor' && workspace()?.actor) return workspace().actor;
    if (!IS_TAURI && key === 'crdt_hlc' && workspace()?.hlc) return JSON.stringify(workspace().hlc);
    if (!IS_TAURI) {
        if (USE_INDEXED_DB) {
            const settings = workspace()?.settings ?? {};
            return Object.prototype.hasOwnProperty.call(settings,key) ? settings[key] : defaultValue;
        }
        return localStorage.getItem(`cn_set_${key}`) || defaultValue;
    }
    const d = await db();
    const rows = await d.select('SELECT value FROM app_state WHERE key=?', [key]);
    return rows.length > 0 ? rows[0].value : defaultValue;
}

export async function setSetting(key, value) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        if (USE_INDEXED_DB) {
            await patchBrowser(state => {
                state.settings = {...state.settings,[key]:String(value)};
                if (key === 'crdt_actor') state.actor = String(value);
            });
        } else localStorage.setItem(`cn_set_${key}`, String(value));
        return;
    }
    const d = await db();
    await d.execute('INSERT INTO app_state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}

/** Browser key registration is one transaction so simultaneous tabs cannot
 * assemble a private key from one generator with another tab's public key. */
export async function registerBrowserIdentity(actor, privateKey, publicKey) {
    if (!USE_INDEXED_DB) throw new Error('Transactional browser identity storage is unavailable.');
    await ensureBrowserStorage();
    if(!isEncryptedSecret(privateKey)) privateKey=await encryptBrowserSecret(privateKey);
    let registered;
    await patchBrowser(state => {
        if (state.actor!==actor) throw new Error('Device actor changed during identity registration.');
        const settings = state.settings ?? {};
        const priv = settings.crdt_signing_key, pub = settings.crdt_signing_pub;
        if (Boolean(priv)!==Boolean(pub)) throw new Error('Signing identity is incomplete. Restore your identity.');
        if (priv && pub) { registered={priv,pub}; return; }
        if (settings.crdt_signing_binding) throw new Error('Registered signing keys are missing. Restore your identity.');
        state.settings = {...settings,crdt_signing_key:privateKey,crdt_signing_pub:publicKey,crdt_signing_binding:JSON.stringify({actor,pub:publicKey})};
        registered={priv:privateKey,pub:publicKey};
    });
    return registered;
}
export const USE_BROWSER_WORKSPACE = USE_INDEXED_DB;

// ── Projects (Phase 3) ────────────────────────────────────
const LOCAL_PROJ_KEY = 'cn_projects_v1';
function localLoadProjects() { return workspace()?.projects ?? safeParseJSON(localStorage.getItem(LOCAL_PROJ_KEY), []); }
async function localSaveProjects(p) { await localSave(localLoad(), p); }

export async function getProjects() {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        return localLoadProjects().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    }
    const d = await db();
    return await d.select('SELECT * FROM projects ORDER BY sort_order ASC, created_at ASC');
}

export async function createProject(name, color = '') {
    if (!IS_TAURI) await ensureBrowserStorage();
    const id = uuid();
    const now = new Date().toISOString();
    if (!IS_TAURI) {
        const list = localLoadProjects();
        const proj = { id, name, color, created_at: now, sort_order: list.length };
        list.push(proj);
        await localSaveProjects(list);
        return proj;
    }
    const d = await db();
    const c = await d.select('SELECT COUNT(*) as c FROM projects');
    const order = c[0].c;
    await d.execute('INSERT INTO projects (id,name,color,created_at,sort_order) VALUES (?,?,?,?,?)', [id, name, color, now, order]);
    return { id, name, color, created_at: now, sort_order: order };
}

export async function updateProject(id, data) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        const list = localLoadProjects().map(p => p.id === id ? { ...p, ...data } : p);
        await localSaveProjects(list);
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
    if (!IS_TAURI) await ensureBrowserStorage();
    const id = p.id;
    if (!id) return;
    const name = p.name ?? '';
    const color = p.color ?? '';
    if (!IS_TAURI) {
        const list = localLoadProjects();
        const i = list.findIndex(x => x.id === id);
        if (i >= 0) list[i] = { ...list[i], name, color };
        else list.push({ id, name, color, created_at: new Date().toISOString(), sort_order: list.length });
        await localSaveProjects(list);
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
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        const projects = localLoadProjects().filter(p => p.id !== id);
        const tasks = localLoad().map(t => t.project_id === id || t.projectId === id ? { ...t, project_id: null, projectId: null } : t);
        await localSave(tasks, projects);
        return;
    }
    const d = await db();
    await d.batch([
        { query: 'UPDATE tasks SET project_id=NULL WHERE project_id=?', values: [id] },
        { query: 'DELETE FROM projects WHERE id=?', values: [id] },
    ]);
}

// ── Milestones (Phase 3) ──────────────────────────────────
const LOCAL_MILE_KEY = 'cn_milestones_v1';
function localLoadMiles() { return USE_INDEXED_DB ? workspace()?.milestones ?? [] : safeParseJSON(localStorage.getItem(LOCAL_MILE_KEY), []); }
async function localSaveMiles(m) {
    if (USE_INDEXED_DB) await commitWorkspace(localLoad(),localLoadOps(),workspace().actor,localLoadProjects(), {milestones:m});
    else localStorage.setItem(LOCAL_MILE_KEY, JSON.stringify(m));
}

export async function getMilestones() {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) return localLoadMiles().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const d = await db();
    return await d.select('SELECT * FROM milestones ORDER BY sort_order ASC, created_at ASC');
}

export async function createMilestone(name, projectId = null, due = '') {
    if (!IS_TAURI) await ensureBrowserStorage();
    const id = uuid();
    const now = new Date().toISOString();
    if (!IS_TAURI) {
        const list = localLoadMiles();
        const m = { id, project_id: projectId, name, due, created_at: now, sort_order: list.length };
        list.push(m);
        await localSaveMiles(list);
        return m;
    }
    const d = await db();
    const c = await d.select('SELECT COUNT(*) as c FROM milestones');
    await d.execute('INSERT INTO milestones (id,project_id,name,due,created_at,sort_order) VALUES (?,?,?,?,?,?)', [id, projectId, name, due, now, c[0].c]);
    return { id, project_id: projectId, name, due, created_at: now, sort_order: c[0].c };
}

export async function updateMilestone(id, data) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSaveMiles(localLoadMiles().map(m => m.id === id ? { ...m, ...data } : m));
        return;
    }
    const d = await db();
    await d.execute('UPDATE milestones SET name=?, due=?, project_id=? WHERE id=?', [data.name, data.due ?? '', data.project_id ?? null, id]);
}

export async function deleteMilestone(id) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSaveMiles(localLoadMiles().filter(m => m.id !== id));
        await localSave(localLoad().map(t => (t.milestone_id === id || t.milestoneId === id) ? { ...t, milestone_id: null, milestoneId: null } : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET milestone_id=NULL WHERE milestone_id=?', [id]);
    await d.execute('DELETE FROM milestones WHERE id=?', [id]);
}

// ── Templates (Phase 3) ───────────────────────────────────
const LOCAL_TPL_KEY = 'cn_templates_v1';
function localLoadTpls() { return USE_INDEXED_DB ? workspace()?.templates ?? [] : safeParseJSON(localStorage.getItem(LOCAL_TPL_KEY), []); }
async function localSaveTpls(t) {
    if (USE_INDEXED_DB) await commitWorkspace(localLoad(),localLoadOps(),workspace().actor,localLoadProjects(), {templates:t});
    else localStorage.setItem(LOCAL_TPL_KEY, JSON.stringify(t));
}

export async function getTemplates() {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) return localLoadTpls();
    const d = await db();
    const rows = await d.select('SELECT * FROM templates ORDER BY created_at DESC');
    return rows.map(r => ({ ...r, data: safeParseJSON(r.data, {}) }));
}

export async function createTemplate(name, data) {
    if (!IS_TAURI) await ensureBrowserStorage();
    const id = uuid();
    const now = new Date().toISOString();
    if (!IS_TAURI) {
        const list = localLoadTpls();
        list.unshift({ id, name, data, created_at: now });
        await localSaveTpls(list);
        return { id, name, data, created_at: now };
    }
    const d = await db();
    await d.execute('INSERT INTO templates (id,name,data,created_at) VALUES (?,?,?,?)', [id, name, JSON.stringify(data), now]);
    return { id, name, data, created_at: now };
}

export async function deleteTemplate(id) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) { await localSaveTpls(localLoadTpls().filter(t => t.id !== id)); return; }
    const d = await db();
    await d.execute('DELETE FROM templates WHERE id=?', [id]);
}

// ── CRUD ──────────────────────────────────────────────────

let _initPromise = null;
export async function initDb() {
    if (!IS_TAURI) await ensureBrowserStorage();
    // Single-flight: concurrent callers (e.g. multiple loadAllTasks, or React
    // StrictMode double-invoking effects in dev) must share ONE init, or the
    // seed-needed check races and the demo tasks get inserted twice.
    if (!_initPromise) {
        _initPromise = (async () => {
            if (await isSeedNeeded()) await seedTasks();
            // Matching content is only a suspicion: intentionally identical
            // tasks must survive startup. Never repair by deleting rows.
            try {
                const groups = await getSuspectedTaskDuplicates();
                if (groups.length > 0) {
                    console.info(`[db.js] ${groups.length} suspected duplicate task group(s); review in Settings → Housekeeping. All tasks preserved.`);
                }
            } catch (e) {
                console.warn('[db.js] duplicate scan failed; all tasks preserved:', e);
            }
        })().catch((e) => {
            _initPromise = null; // let a failed init be retried
            throw e;
        });
    }
    return _initPromise;
}

/** Explicit checkpoint: propagate errors and detect busy readers. Backups
 * use SQLite's online backup API and do not depend on this operation. */
export async function checkpoint() {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) return;
    const d = await db();
    const rows = await d.select('PRAGMA wal_checkpoint(TRUNCATE)');
    if (!rows.length || Number(rows[0].busy) !== 0) {
        throw new Error('Database checkpoint could not complete: active SQLite reader.');
    }
}

/**
 * Run SQLite's own consistency checks. Returns 'ok' when healthy, otherwise a
 * short description of the first problem found. Off Tauri there is no SQLite,
 * so we report healthy.
 */
export async function integrityCheck() {
    if (!IS_TAURI) await ensureBrowserStorage();
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
    if (!IS_TAURI) await ensureBrowserStorage();
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
 * Read-only candidates for manual review. Matching content does not establish
 * that a task is redundant. Return every ID in each group without choosing a
 * keeper, changing rows, or writing tombstones.
 */
export function findSuspectedTaskDuplicates(tasks) {
    const groups = new Map();
    for (const raw of tasks) {
        const t = rowToTask(raw);
        if (t.deleted_at) continue;
        const key = JSON.stringify([
            t.title ?? '', t.description ?? '', t.deadline ?? '',
            t.project_id, t.parent_id, t.milestone_id, t.recurrence,
        ]);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
    }
    return [...groups.values()]
        .filter(group => group.length > 1)
        .map(group => ({ title: group[0].title ?? '', taskIds: group.map(t => t.id) }));
}

/** Scan live task rows without modifying either task storage or the op-log. */
export async function getSuspectedTaskDuplicates() {
    if (!IS_TAURI) await ensureBrowserStorage();
    return findSuspectedTaskDuplicates(await getAllTasks('all'));
}

export async function createTask(data) {
    if (!IS_TAURI) await ensureBrowserStorage();
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
        await localSave(tasks);
        return task;
    }
    const d = await db();
    const allRows = await d.select('SELECT COUNT(*) as c FROM tasks');
    task.sortOrder = allRows[0].c;
    task.sort_order = allRows[0].c;
    await d.execute(
        `INSERT INTO tasks (id,title,description,tags,deadline,importance,effort,done,created_at,completed_at,pomodoros_spent,priority,sort_order,project_id,parent_id,recurrence,milestone_id,custom_fields,duration_min,energy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, task.title, task.description, JSON.stringify(tags), task.deadline, task.importance, task.effort, 0, now, null, 0, priority, task.sortOrder, projectId, parentId, recurrence, milestoneId, JSON.stringify(customFields), task.duration_min, task.energy]
    );
    return task;
}

/**
 * Write a full task row verbatim (no priority recompute, no id generation).
 * The reconciler uses this to make SQLite match the op-log projection — the
 * "SQLite is a projection" mechanism (Act 2). Idempotent via INSERT OR REPLACE.
 */
export async function upsertTaskRaw(t) {
    if (!IS_TAURI) await ensureBrowserStorage();
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
        await localSave(tasks);
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
    if (!IS_TAURI) await ensureBrowserStorage();
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
        await localSave(tasks);
        return rowToTask(tasks.find(t => t.id === id));
    }
    const d = await db();
    await d.execute(
        `UPDATE tasks SET title=?,description=?,tags=?,deadline=?,importance=?,effort=?,priority=?,project_id=?,parent_id=?,recurrence=?,milestone_id=?,custom_fields=?,duration_min=COALESCE(?,duration_min),energy=COALESCE(?,energy) WHERE id=?`,
        [data.title, data.description, JSON.stringify(tags), data.deadline, data.importance, data.effort, priority, projectId, data.parent_id ?? null, recurrence, milestoneId, JSON.stringify(customFields), data.duration_min ?? null, data.energy ?? null, id]
    );
    const rows = await d.select('SELECT * FROM tasks WHERE id=?', [id]);
    return rowToTask(rows[0]);
}

/** Soft-delete: stamp deleted_at so the task drops out of every live view but stays recoverable. */
export async function softDeleteTask(id, when = new Date().toISOString()) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSave(localLoad().map(t => t.id === id ? { ...t, deleted_at: when, deletedAt: when } : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET deleted_at=? WHERE id=?', [when, id]);
}

/** Restore a soft-deleted task by clearing its deleted_at stamp. */
export async function restoreTask(id) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSave(localLoad().map(t => t.id === id ? { ...t, deleted_at: null, deletedAt: null } : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET deleted_at=NULL WHERE id=?', [id]);
}

/** Return only the soft-deleted tasks (the Trash), newest-deleted first. */
export async function getTrash() {
    if (!IS_TAURI) await ensureBrowserStorage();
    return getAllTasks('trash');
}

/** Permanently remove a single task (purge from Trash). */
export async function deleteTask(id) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSave(localLoad().filter(t => t.id !== id));
        return;
    }
    const d = await db();
    await d.execute('DELETE FROM tasks WHERE id=?', [id]);
}

/** Permanently remove every soft-deleted task. Returns the count purged. */
export async function emptyTrash() {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        const all = localLoad();
        const kept = all.filter(t => !t.deleted_at && !t.deletedAt);
        await localSave(kept);
        return all.length - kept.length;
    }
    const d = await db();
    const before = await d.select('SELECT COUNT(*) as c FROM tasks WHERE deleted_at IS NOT NULL');
    await d.execute('DELETE FROM tasks WHERE deleted_at IS NOT NULL');
    return before[0]?.c ?? 0;
}

export async function toggleTask(id) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        const tasks = localLoad();
        const t = tasks.find(t => t.id === id);
        t.done = !t.done;
        t.completedAt = t.done ? new Date().toISOString() : null;
        t.completed_at = t.completedAt;
        if (t.done && t.recurrence && t.recurrence !== 'none') {
            const deadline = nextDeadline(t.deadline, t.recurrence);
            const nextId = recurrenceId(t.id, deadline);
            if (!tasks.some(task => task.id === nextId)) {
                const created = new Date().toISOString();
                tasks.push({ ...t, id: nextId, deadline, done: false,
                    created_at: created, createdAt: created, completed_at: null, completedAt: null,
                    pomodoros_spent: 0, pomodorosSpent: 0, pinned: false,
                    scheduled_start: null, scheduled_end: null, deleted_at: null,
                    sort_order: tasks.length, sortOrder: tasks.length });
            }
        }
        await localSave(tasks);
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
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        let tasks = localLoad();
        tasks.forEach(t => {
            const idx = orderedIds.indexOf(t.id);
            if (idx >= 0) { t.sortOrder = idx; t.sort_order = idx; }
        });
        await localSave(tasks);
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
    
    await d.execute(query, args);
}

export async function addPomodoro(id) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        const tasks = localLoad().map(t => t.id === id ? { ...t, pomodorosSpent: (t.pomodoros_spent ?? t.pomodorosSpent ?? 0) + 1, pomodoros_spent: (t.pomodoros_spent ?? t.pomodorosSpent ?? 0) + 1 } : t);
        await localSave(tasks);
        return rowToTask(tasks.find(t => t.id === id));
    }
    const d = await db();
    await d.execute('UPDATE tasks SET pomodoros_spent = pomodoros_spent + 1 WHERE id=?', [id]);
    const rows = await d.select('SELECT * FROM tasks WHERE id=?', [id]);
    return rowToTask(rows[0]);
}

// ── Scheduling & Calendar (Act 1: Planner) ────────────────

const PLANNING_KEYS = ['use_custom_work_hours','work_start_min','work_end_min','wake_start_min','wake_end_min'];
function planningSettings(settings) {
    return Object.fromEntries(Object.entries(settings ?? {}).filter(([key]) => PLANNING_KEYS.includes(key) || key.startsWith('plan:')));
}
function browserPlanningSnapshot() {
    const state = workspace();
    return {tasks:localLoad().map(rowToTask).map(t => ({id:t.id,...taskRecord(t)})),calendar:localLoadCal().sort((a,b) => a.id.localeCompare(b.id)),settings:planningSettings(state?.settings ?? Object.fromEntries(PLANNING_KEYS.map(key => [key,localStorage.getItem(`cn_set_${key}`)]).filter(([,value]) => value!==null)))};
}
export async function getPlanningSnapshot() {
    if (!IS_TAURI) {
        await ensureBrowserStorage();
        return browserPlanningSnapshot();
    }
    await db();
    const {invoke} = await import('@tauri-apps/api/core');
    return guardedCall({read:() => invoke('planning_snapshot')},'read',[]);
}
/** Reject stale solves and commit schedules, history, revision, and explanations together. */
export async function commitPlan(date, result, expected) {
    if (!IS_TAURI) await ensureBrowserStorage();
    const record = JSON.stringify({revision:uuid(),created_at:new Date().toISOString(),...result,inputs:planInputKey(expected,date,result)});
    if (!IS_TAURI) {
        if (canonicalJson(browserPlanningSnapshot()) !== canonicalJson(expected)) throw new Error('Tasks, calendar, or working hours changed while planning. Retry the plan.');
        const blocks = new Map(result.blocks.map(block => [block.task_id,block]));
        const iso = min => {
            const d = new Date(`${date}T00:00:00`); d.setMinutes(min);
            return `${getLocalDateString(d)}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:00`;
        };
        const tasks = localLoad().map(task => {
            if (task.done || task.deleted_at) return task;
            const block = blocks.get(task.id);
            if (block) return {...task,scheduled_start:iso(block.start_min),scheduled_end:iso(block.end_min),...(result.pin?.task_id===task.id ? {pinned:true,duration_min:result.pin.duration_min} : {})};
            if (!task.pinned && String(task.scheduled_start).slice(0,10)===date) return {...task,scheduled_start:null,scheduled_end:null};
            return task;
        });
        await localSave(tasks,localLoadProjects(),{settings:{...workspace()?.settings,[`plan:${date}`]:record}});
        return;
    }
    await db();
    const {invoke} = await import('@tauri-apps/api/core');
    await guardedCall({commit:() => invoke('commit_plan',{date,result,expected,record})},'commit',[]);
}

/** Persist a planner-assigned time block (ISO datetimes) onto a task. */
export async function setSchedule(id, start, end) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSave(localLoad().map(t => t.id === id
            ? { ...t, scheduled_start: start, scheduled_end: end, scheduledStart: start, scheduledEnd: end }
            : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET scheduled_start=?, scheduled_end=? WHERE id=?', [start, end, id]);
}

/** Pin/unpin a task to its scheduled slot (the planner won't re-flow a pin). */
export async function setPinned(id, pinned) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSave(localLoad().map(t => t.id === id ? { ...t, pinned: !!pinned } : t));
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
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        await localSave(localLoad().map(t => {
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
    if (!IS_TAURI) await ensureBrowserStorage();
    const dur = fields.duration_min ?? 0;
    const energy = fields.energy ?? 'med';
    const pinned = fields.pinned ? 1 : 0;
    if (!IS_TAURI) {
        await localSave(localLoad().map(t => t.id === id
            ? { ...t, duration_min: dur, energy, pinned: !!fields.pinned }
            : t));
        return;
    }
    const d = await db();
    await d.execute('UPDATE tasks SET duration_min=?, energy=?, pinned=? WHERE id=?', [dur, energy, pinned, id]);
}

const LOCAL_CAL_KEY = 'cn_calevents_v1';
function localLoadCal() { return USE_INDEXED_DB ? workspace()?.calendar_events ?? [] : safeParseJSON(localStorage.getItem(LOCAL_CAL_KEY), []); }
async function localSaveCal(e) {
    if (USE_INDEXED_DB) await commitWorkspace(localLoad(),localLoadOps(),workspace().actor,localLoadProjects(), {calendar_events:e});
    else localStorage.setItem(LOCAL_CAL_KEY, JSON.stringify(e));
}

export async function getCalendarEvents() {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) return localLoadCal().sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const d = await db();
    return await d.select('SELECT * FROM calendar_events ORDER BY start ASC');
}

export async function createCalendarEvent({ title = '', start, end, source = 'manual' }) {
    if (!IS_TAURI) await ensureBrowserStorage();
    const id = uuid();
    const now = new Date().toISOString();
    const ev = { id, title, start, end, source, created_at: now };
    if (!IS_TAURI) {
        if (USE_INDEXED_DB) await patchBrowser(state => { state.calendar_events = [...(state.calendar_events ?? []),ev]; });
        else await localSaveCal([...localLoadCal(),ev]);
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
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        if (USE_INDEXED_DB) await patchBrowser(state => { state.calendar_events = (state.calendar_events ?? []).filter(e => e.id !== id); });
        else await localSaveCal(localLoadCal().filter(e => e.id !== id));
        return;
    }
    const d = await db();
    await d.execute('DELETE FROM calendar_events WHERE id=?', [id]);
}

/** Remove all calendar events from a given source (e.g. refreshing an .ics feed). */
function notifyCalendarChange() {if(typeof window!=='undefined')window.dispatchEvent(new Event('calendar-changed'));}
export async function clearCalendarSource(source) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) {
        if (USE_INDEXED_DB) await patchBrowser(state => { state.calendar_events = (state.calendar_events ?? []).filter(e => e.source !== source); });
        else await localSaveCal(localLoadCal().filter(e => e.source !== source));
        notifyCalendarChange();return;
    }
    const d = await db();
    await d.execute('DELETE FROM calendar_events WHERE source=?', [source]);notifyCalendarChange();
}

/** Replace a fetched calendar source atomically; failed refresh retains its old events. */
export async function replaceCalendarSource(source, events, metadata = null) {
    if (!IS_TAURI) await ensureBrowserStorage();
    const rows = events.map(event => ({...event, id:uuid(), source, created_at:new Date().toISOString()}));
    for (const row of rows) {
        if (!Number.isFinite(Date.parse(row.start)) || !Number.isFinite(Date.parse(row.end)) || Date.parse(row.end) <= Date.parse(row.start)) {
            throw new Error('Calendar events must have a valid start before end.');
        }
    }
    if (!IS_TAURI) {
        if (USE_INDEXED_DB) await patchBrowser(state => { state.calendar_events = [...(state.calendar_events ?? []).filter(e => e.source !== source),...rows]; if (metadata) state.settings = {...state.settings,[`calendar_meta:${source}`]:JSON.stringify(metadata)}; });
        else { await localSaveCal([...localLoadCal().filter(e => e.source !== source),...rows]); if(metadata) await setSetting(`calendar_meta:${source}`,JSON.stringify(metadata)); }
        notifyCalendarChange();return;
    }
    await db();
    await guardedCall({execute:async () => {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke('replace_calendar_source',{source, events:rows,metadata});
    }},'execute',[]);
    notifyCalendarChange();
}

// ── CRDT op-log (Act 2: Sync Spine) ───────────────────────
// Append-only operation store. Persisted as the future source of truth;
// today it shadows the SQLite tables so we can prove convergence first.

const LOCAL_OPLOG_KEY = 'cn_oplog_v1';
function localLoadOps() { return workspace()?.ops ?? safeParseJSON(localStorage.getItem(LOCAL_OPLOG_KEY), []); }
async function localSaveOps(ops) {
    const actor = workspace()?.actor || localStorage.getItem('cn_set_crdt_actor') || uuid();
    await commitWorkspace(localLoad(), ops, actor);
}

/** Load the full op-log, oldest first. Each row is rehydrated to an `Op`. */
export async function loadOps() {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!IS_TAURI) return localLoadOps();
    const d = await db();
    const rows = await d.select('SELECT * FROM oplog ORDER BY wall ASC, counter ASC, actor ASC');
    return rows.map(r => r.kind === 'del'
        ? { id: r.id, hlc: { wall: r.wall, counter: r.counter, actor: r.actor }, kind: 'del', entity: r.entity }
        : { id: r.id, hlc: { wall: r.wall, counter: r.counter, actor: r.actor }, kind: 'set', entity: r.entity, field: r.field, value: JSON.parse(r.value) });
}

/** Validate collisions before committing. Browser setItem is one atomic write;
 * native append commits the full batch in one SQLite transaction. */
export async function appendOps(ops, expected = null) {
    if (!IS_TAURI) await ensureBrowserStorage();
    if (!ops || ops.length === 0) return;
    if (!IS_TAURI) {
        if (expected) {
            if(expected.planning && canonicalJson(browserPlanningSnapshot())!==canonicalJson(expected.planning)) throw new Error('Planning inputs changed; review a fresh proposal.');
            const currentTasks = localLoad().map(rowToTask).map(expected.normalizeTask);
            const currentProjects = localLoadProjects();
            if (expected.fingerprint(currentTasks, currentProjects, localLoadOps()) !== expected.fingerprint(expected.tasks, expected.projects, expected.ops)) {
                throw new Error('Local state changed since the audit. Export a fresh audit before repairing.');
            }
        }
        await localSaveOps(merge(localLoadOps(), ops));
        return;
    }
    const valid = merge(ops).map(op => op.kind === 'set'
        ? { id: op.id, hlc: { wall: op.hlc.wall, counter: op.hlc.counter, actor: op.hlc.actor }, kind: op.kind, entity: op.entity, field: op.field, value: op.value }
        : { id: op.id, hlc: { wall: op.hlc.wall, counter: op.hlc.counter, actor: op.hlc.actor }, kind: op.kind, entity: op.entity });
    await db(); // Ensure plugin migrations have completed.
    const { invoke } = await import('@tauri-apps/api/core');
    await guardedCall({ append: () => invoke('append_operations', { ops: valid, expected: expected ? { tasks: expected.tasks, projects: expected.projects, ops: expected.ops, planning: expected.planning ?? null } : null }) }, 'append', []);
}

/** Transactional import with a local-state precondition. No generated local
 * writes are added while materializing the already validated merged history. */
export async function commitProjection(ops, tasks, projects, expected, recovery = null) {
    if(recovery && (expected.tasks.length || expected.projects.length || expected.ops.length)) throw new Error('Identity recovery requires an empty workspace.');
    if (!IS_TAURI) await ensureBrowserStorage();
    const combined = merge(expected.ops, ops);
    if (!IS_TAURI) {
        const currentTasks = localLoad().map(rowToTask).map(expected.normalizeTask);
        if (expected.fingerprint(currentTasks, localLoadProjects(), localLoadOps()) !== expected.fingerprint(expected.tasks, expected.projects, expected.ops)) {
            throw new Error('Local state changed during sync; retry the import.');
        }
        const actor = workspace()?.actor || localStorage.getItem('cn_set_crdt_actor') || uuid();
        const extra = recovery ? {settings:{...workspace()?.settings,recovery_completed_data:recovery.kitId,crdt_actor:recovery.actor,crdt_signing_key:recovery.privateKey,crdt_signing_pub:recovery.pub,crdt_signing_binding:JSON.stringify({actor:recovery.actor,pub:recovery.pub})}} : {};
        await commitWorkspace(tasks, combined, recovery?.actor ?? actor, projects,extra);
        if(recovery && !USE_INDEXED_DB) {for(const [key,value] of Object.entries(extra.settings)) await setSetting(key,value);}

        return;
    }
    await db();
    const { invoke } = await import('@tauri-apps/api/core');
    await guardedCall({ commit: () => invoke('commit_projection', {
        ops, tasks, projects, expected: { tasks: expected.tasks, projects: expected.projects, ops: expected.ops },
        recovery:recovery ? {actor:recovery.actor,pub_key:recovery.pub,kit_id:recovery.kitId} : null,
    }) }, 'commit', []);
}

// M2: Aggregated SQL getStats
export async function getStats() {
    if (!IS_TAURI) await ensureBrowserStorage();
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
