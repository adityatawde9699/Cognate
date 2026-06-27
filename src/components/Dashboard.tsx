import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useStore, Task } from '../store';
import { getStats, IS_TAURI } from '../db';
import { fmtDate, isOverdue } from '../utils/format';
import { toast } from '../utils/toast';

const WORK = 25 * 60;
const ARC_LEN = 267.04; // π·r, r = 85

const AVA = ['#16794f', '#0e7490', '#9333ea', '#b45309', '#be123c', '#4338ca'];

function initials(s: string) {
  const parts = s.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '•';
}

export function Dashboard() {
  const tasks = useStore((s) => s.currentTasks);
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);
  const setAnalyticsOpen = useStore((s) => s.setAnalyticsOpen);
  const setFilter = useStore((s) => s.setFilter);

  const [stats, setStats] = useState<any>(null);
  const [timeLeft, setTimeLeft] = useState(WORK);
  const [mode, setMode] = useState<'work' | 'break'>('work');
  const [running, setRunning] = useState(false);

  useEffect(() => { getStats().then(setStats); }, [tasks]);

  useEffect(() => {
    let offTick: (() => void) | undefined;
    let offDone: (() => void) | undefined;
    (async () => {
      if (!IS_TAURI) return; // No Rust timer events in the browser fallback.
      offTick = await listen<{ remaining: number; total: number; mode: 'work' | 'break' }>(
        'pomo-tick',
        (e) => { setTimeLeft(e.payload.remaining); setMode(e.payload.mode); setRunning(true); }
      );
      offDone = await listen('pomo-finished', () => { setRunning(false); });
    })();
    return () => { offTick?.(); offDone?.(); };
  }, []);

  const trackerToggle = async () => {
    try { setRunning(await invoke<boolean>('toggle_pomodoro')); }
    catch { setRunning((r) => !r); }
  };
  const trackerStop = async () => {
    try { await invoke('reset_pomodoro'); } catch { /* browser */ }
    setRunning(false); setTimeLeft(WORK);
  };

  const total = tasks.length;
  const done = tasks.filter((t) => t.done).length;
  const active = total - done;
  const flagged = tasks.filter((t) => t.priority === 'high' && !t.done).length;
  const inProgress = tasks.filter((t) => !t.done && t.pomodoros_spent > 0).length;
  const pending = active - inProgress;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const projects = new Set(tasks.flatMap((t) => t.tags || [])).size;
  const weekDone: number = stats?.weekData?.reduce((n: number, d: any) => n + d.count, 0) ?? 0;

  const open = tasks.filter((t) => !t.done);
  const upcoming = open
    .filter((t) => t.deadline)
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
  const reminder = upcoming[0];
  const projectList = [...upcoming, ...open.filter((t) => !t.deadline)].slice(0, 5);
  const recent = [...tasks]
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 4);

  // Week chart
  const week = stats?.weekData ?? [];
  const maxCount = Math.max(1, ...week.map((d: any) => d.count));
  const peakIdx = week.reduce((mi: number, d: any, i: number) => (d.count > week[mi].count ? i : mi), 0);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const startFocus = (t?: Task) => {
    if (!t) { toast('No upcoming reminders'); return; }
    useStore.setState({ pomoTaskId: t.id } as any);
    trackerToggle();
    toast(`⏱ Focusing on “${t.title}”`);
  };

  const statusOf = (t: Task) =>
    t.done ? { l: 'Completed', c: 'ok' } : t.pomodoros_spent > 0 ? { l: 'In Progress', c: 'wip' } : { l: 'Pending', c: 'wait' };

  const cards = [
    { k: 'total', label: 'Total Tasks', val: total, cap: `Across ${projects} project${projects === 1 ? '' : 's'}`, feat: true },
    { k: 'done', label: 'Completed', val: done, cap: `${pct}% completion rate` },
    { k: 'active', label: 'In Progress', val: active, cap: `${stats?.todayCount ?? 0} due today` },
    { k: 'flag', label: 'Flagged', val: flagged, cap: 'High priority' },
  ];

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1 className="dash-title">Dashboard</h1>
          <p className="dash-sub">Plan, prioritize, and accomplish your tasks with ease.</p>
        </div>
        <div className="dash-head-actions">
          <button className="btn-primary" onClick={() => setTaskModalOpen(true)}>
            <i className="fa-solid fa-plus"></i> Add Task
          </button>
          <button className="btn-ghost-pill" onClick={() => setAnalyticsOpen(true)}>
            <i className="fa-solid fa-chart-simple"></i> Insights
          </button>
        </div>
      </header>

      <div className="dash-grid">
        {/* ── Stat cards ─────────────────────────────── */}
        {cards.map((c) => (
          <button
            key={c.k}
            className={`stat-card ${c.feat ? 'feat' : ''}`}
            onClick={() => setFilter(c.k === 'flag' ? 'high' : c.k === 'active' ? 'all' : 'all')}
          >
            <div className="stat-top">
              <span className="stat-label">{c.label}</span>
              <span className="stat-arrow"><i className="fa-solid fa-arrow-up-right-from-square"></i></span>
            </div>
            <div className="stat-num">{c.val}</div>
            <div className="stat-cap"><i className="fa-solid fa-arrow-trend-up"></i> {c.cap}</div>
          </button>
        ))}

        {/* ── Project Analytics ──────────────────────── */}
        <section className="panel panel-analytics">
          <div className="panel-hd">
            <h3>Task Analytics</h3>
            <span className="panel-meta">This week</span>
          </div>
          <div className="bars">
            {week.map((d: any, i: number) => (
              <div className="bar-col" key={i}>
                {i === peakIdx && maxCount > 0 && (
                  <span className="bar-badge">{Math.round((d.count / Math.max(1, weekDone)) * 100)}%</span>
                )}
                <div className="bar-track">
                  <div
                    className={`bar-fill ${i === peakIdx ? 'peak' : ''} ${d.count === 0 ? 'empty' : ''}`}
                    style={{ height: `${Math.max(8, (d.count / maxCount) * 100)}%` }}
                  ></div>
                </div>
                <span className="bar-lbl">{(d.label || '')[0]}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Reminders ──────────────────────────────── */}
        <section className="panel panel-reminder">
          <div className="panel-hd"><h3>Reminders</h3></div>
          {reminder ? (
            <>
              <p className="rem-title">{reminder.title}</p>
              <p className="rem-time">
                <i className="fa-regular fa-clock"></i>
                {isOverdue(reminder.deadline) ? 'Overdue · ' : 'Due '}{fmtDate(reminder.deadline)}
              </p>
              <button className="btn-focus" onClick={() => startFocus(reminder)}>
                <i className="fa-solid fa-play"></i> Start Focus
              </button>
            </>
          ) : (
            <p className="rem-empty">No upcoming deadlines. You're clear. ✨</p>
          )}
        </section>

        {/* ── Project / task list ────────────────────── */}
        <section className="panel panel-projects">
          <div className="panel-hd">
            <h3>Tasks</h3>
            <button className="pill-new" onClick={() => setTaskModalOpen(true)}>+ New</button>
          </div>
          <ul className="proj-list">
            {projectList.length === 0 && <li className="proj-empty">No active tasks.</li>}
            {projectList.map((t, i) => (
              <li key={t.id} className="proj-row" onClick={() => setTaskModalOpen(true, t)}>
                <span className="proj-ico" style={{ background: AVA[i % AVA.length] }}>
                  <i className="fa-solid fa-diagram-project"></i>
                </span>
                <div className="proj-info">
                  <span className="proj-name">{t.title}</span>
                  <span className="proj-date">{t.deadline ? `Due ${fmtDate(t.deadline)}` : 'No deadline'}</span>
                </div>
                <span className={`proj-dot ${t.priority}`}></span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Recent activity (Team Collaboration slot) ─ */}
        <section className="panel panel-activity">
          <div className="panel-hd">
            <h3>Recent Activity</h3>
            <button className="pill-new" onClick={() => setTaskModalOpen(true)}>+ Add Task</button>
          </div>
          <ul className="act-list">
            {recent.length === 0 && <li className="proj-empty">Nothing here yet.</li>}
            {recent.map((t, i) => {
              const st = statusOf(t);
              return (
                <li key={t.id} className="act-row" onClick={() => setTaskModalOpen(true, t)}>
                  <span className="act-ava" style={{ background: AVA[i % AVA.length] }}>{initials(t.title)}</span>
                  <div className="act-info">
                    <span className="act-name">{t.title}</span>
                    <span className="act-sub">{(t.tags?.[0] && `#${t.tags[0]}`) || `${t.priority} priority`}</span>
                  </div>
                  <span className={`act-badge ${st.c}`}>{st.l}</span>
                </li>
              );
            })}
          </ul>
        </section>

        {/* ── Project Progress gauge ─────────────────── */}
        <section className="panel panel-progress">
          <div className="panel-hd"><h3>Task Progress</h3></div>
          <div className="gauge-wrap">
            <svg viewBox="0 0 220 132" className="gauge">
              <path className="g-track" d="M 25 115 A 85 85 0 0 1 195 115" />
              <path
                className="g-val"
                d="M 25 115 A 85 85 0 0 1 195 115"
                strokeDasharray={`${ARC_LEN} ${ARC_LEN}`}
                style={{ strokeDashoffset: ARC_LEN * (1 - pct / 100) }}
              />
            </svg>
            <div className="gauge-center">
              <span className="gauge-pct">{pct}%</span>
              <span className="gauge-lbl">Tasks Done</span>
            </div>
          </div>
          <div className="gauge-legend">
            <span><i className="dot ok"></i> Completed {done}</span>
            <span><i className="dot wip"></i> In Progress {inProgress}</span>
            <span><i className="dot wait"></i> Pending {pending}</span>
          </div>
        </section>

        {/* ── Time Tracker ───────────────────────────── */}
        <section className={`panel panel-tracker ${running ? 'live' : ''}`}>
          <div className="tracker-hd">
            <span><i className="fa-regular fa-clock"></i> {mode === 'break' ? 'On Break' : 'Time Tracker'}</span>
            {running && <span className="live-dot">● Live</span>}
          </div>
          <div className="tracker-time">{fmt(timeLeft)}</div>
          <div className="tracker-ctrls">
            <button className="trk-btn" onClick={trackerToggle} title="Play / Pause">
              <i className={`fa-solid ${running ? 'fa-pause' : 'fa-play'}`}></i>
            </button>
            <button className="trk-btn stop" onClick={trackerStop} title="Stop">
              <i className="fa-solid fa-stop"></i>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
