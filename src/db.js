/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/db.js — SQLite database abstraction layer
   Uses @tauri-apps/plugin-sql in native Tauri context,
   falls back to localStorage for browser-only testing.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
// Use native crypto.randomUUID() — available in all modern browsers & Tauri WebView
const uuid = () => crypto.randomUUID();

// ── Detect Tauri runtime ────────────────────────────────────
export const IS_TAURI = Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

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

function localLoad() { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); }
function localSave(t) { localStorage.setItem(LOCAL_KEY, JSON.stringify(t)); }

function rowToTask(r) {
    return {
        ...r,
        done: Boolean(r.done),
        tags: Array.isArray(r.tags) ? r.tags : JSON.parse(r.tags || '[]'),
        pomodorosSpent: r.pomodoros_spent ?? r.pomodorosSpent ?? 0,
        createdAt: r.created_at ?? r.createdAt,
        completedAt: r.completed_at ?? r.completedAt ?? null,
        sortOrder: r.sort_order ?? r.sortOrder ?? 0,
    };
}

// ── Seed data (Cognote starter tasks) ─────────────────────────────
const today = new Date().toISOString().split('T')[0];
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().split('T')[0];
const in3days = new Date(Date.now() + 3 * 86_400_000).toISOString().split('T')[0];
const in7days = new Date(Date.now() + 7 * 86_400_000).toISOString().split('T')[0];
const in10days = new Date(Date.now() + 10 * 86_400_000).toISOString().split('T')[0];

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
    return rows.length === 0;
}

async function seedTasks() {
    const d = await db();
    const now = new Date().toISOString();
    let order = 0;
    for (const s of SEED_TASKS) {
        const id = uuid();
        const priority = calcPriority(s.importance, s.effort, s.deadline);
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
            tasks.push({ id, title: s.title, description: s.description, tags: s.tags, deadline: s.deadline, importance: s.importance, effort: s.effort, done: !!s.done, createdAt: now, completedAt: compAt, pomodorosSpent: s.pomodorosSpent ?? 0, priority, sortOrder: order++ });
            localSave(tasks);
        }
    }
    if (IS_TAURI) {
        await d.execute("INSERT OR IGNORE INTO app_state (key,value) VALUES ('seeded','1')");
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

// ── CRUD ──────────────────────────────────────────────────

export async function initDb() {
    if (await isSeedNeeded()) await seedTasks();
}

export async function getAllTasks(filter = 'all') {
    if (!IS_TAURI) {
        let tasks = localLoad().map(rowToTask);
        const todayStr = new Date().toISOString().split('T')[0];
        if (filter === 'today') tasks = tasks.filter(t => t.deadline === todayStr);
        if (filter === 'high') tasks = tasks.filter(t => t.priority === 'high' && !t.done);
        // M5: tag filter support
        if (filter.startsWith('tag:')) {
            const tag = filter.split(':')[1];
            tasks = tasks.filter(t => (t.tags || []).includes(tag));
        }
        return tasks.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    }
    const d = await db();
    const todayStr = new Date().toISOString().split('T')[0];

    // S4: Parameterized queries
    if (filter === 'today') {
        const rows = await d.select('SELECT * FROM tasks WHERE deadline = ? ORDER BY sort_order ASC, created_at DESC', [todayStr]);
        return rows.map(rowToTask);
    }
    if (filter === 'high') {
        const rows = await d.select('SELECT * FROM tasks WHERE priority = ? AND done = ? ORDER BY sort_order ASC, created_at DESC', ['high', 0]);
        return rows.map(rowToTask);
    }
    if (filter.startsWith('tag:')) {
        const tag = filter.split(':')[1];
        // JSON1 function exists in SQLite 3.38+
        const rows = await d.select("SELECT * FROM tasks WHERE EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?) ORDER BY sort_order ASC, created_at DESC", [tag]);
        return rows.map(rowToTask);
    }

    const rows = await d.select('SELECT * FROM tasks ORDER BY sort_order ASC, created_at DESC');
    return rows.map(rowToTask);
}

export async function createTask(data) {
    const id = uuid();
    const priority = calcPriority(data.importance, data.effort, data.deadline);
    const now = new Date().toISOString();
    const tags = data.tags || [];
    const task = { id, ...data, tags, done: false, createdAt: now, completedAt: null, pomodorosSpent: 0, priority, sortOrder: 0 };

    if (!IS_TAURI) {
        const tasks = localLoad();
        task.sortOrder = tasks.length;
        tasks.push(task);
        localSave(tasks);
        return task;
    }
    const d = await db();
    const allRows = await d.select('SELECT COUNT(*) as c FROM tasks');
    task.sortOrder = allRows[0].c;
    await d.execute(
        `INSERT INTO tasks (id,title,description,tags,deadline,importance,effort,done,created_at,completed_at,pomodoros_spent,priority,sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, task.title, task.description, JSON.stringify(tags), task.deadline, task.importance, task.effort, 0, now, null, 0, priority, task.sortOrder]
    );
    return task;
}

export async function updateTask(id, data) {
    const priority = calcPriority(data.importance, data.effort, data.deadline);
    const tags = Array.isArray(data.tags) ? data.tags : (data.tags || '').split(',').map(t => t.trim()).filter(Boolean);

    if (!IS_TAURI) {
        const tasks = localLoad().map(t => t.id === id ? { ...t, ...data, tags, priority } : t);
        localSave(tasks);
        return tasks.find(t => t.id === id);
    }
    const d = await db();
    await d.execute(
        `UPDATE tasks SET title=?,description=?,tags=?,deadline=?,importance=?,effort=?,priority=? WHERE id=?`,
        [data.title, data.description, JSON.stringify(tags), data.deadline, data.importance, data.effort, priority, id]
    );
    const rows = await d.select('SELECT * FROM tasks WHERE id=?', [id]);
    return rowToTask(rows[0]);
}

export async function deleteTask(id) {
    if (!IS_TAURI) {
        localSave(localLoad().filter(t => t.id !== id));
        return;
    }
    const d = await db();
    await d.execute('DELETE FROM tasks WHERE id=?', [id]);
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

// M2: Aggregated SQL getStats
export async function getStats() {
    const today = new Date().toISOString().split('T')[0];
    let s = { total: 0, done: 0, urgent: 0, pomos: 0, high: 0, medium: 0, low: 0, todayCount: 0, highPending: 0 };
    let completedDates = [];

    if (!IS_TAURI) {
        const tasks = localLoad().map(rowToTask);
        s.total = tasks.length;
        s.done = tasks.filter(t => t.done).length;
        s.urgent = tasks.filter(t => t.priority === 'high' && !t.done).length;
        s.pomos = tasks.reduce((sum, t) => sum + (t.pomodorosSpent || 0), 0);
        s.high = tasks.filter(t => t.priority === 'high').length;
        s.medium = tasks.filter(t => t.priority === 'medium').length;
        s.low = tasks.filter(t => t.priority === 'low').length;
        s.todayCount = tasks.filter(t => t.deadline === today).length;
        s.highPending = s.urgent;
        completedDates = tasks.filter(t => t.completedAt).map(t => t.completedAt.split('T')[0]);
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
        const datesRes = await d.select('SELECT completed_at FROM tasks WHERE completed_at IS NOT NULL');
        completedDates = datesRes.map(r => r.completed_at.split('T')[0]);
    }

    const focusHrs = parseFloat((s.pomos * 25 / 60).toFixed(1));

    // Streak logic
    const completedSet = new Set(completedDates);
    let streak = 0, checkDay = new Date();
    while (completedSet.has(checkDay.toISOString().split('T')[0])) {
        streak++;
        checkDay.setDate(checkDay.getDate() - 1);
    }

    // Week chart data
    const weekData = [];
    for (let i = 6; i >= 0; i--) {
        const date = new Date(Date.now() - i * 86_400_000);
        const key = date.toISOString().split('T')[0];
        weekData.push({
            label: date.toLocaleDateString('en', { weekday: 'short' }),
            count: completedDates.filter(d => d === key).length
        });
    }

    return { ...s, focusHrs, streak, weekData };
}
