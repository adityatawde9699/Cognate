import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useStore, Task } from '../store';
import { getStats, IS_TAURI } from '../db';
import { fmtDate, isOverdue } from '../utils/format';
import { toast } from '../utils/toast';

const WORK = 25 * 60;

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

  // Week chart: today is the last bar and the only one that carries the accent
  const week = stats?.weekData ?? [];
  const maxCount = Math.max(1, ...week.map((d: any) => d.count));
  const todayIdx = week.length - 1;

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const startFocus = (t?: Task) => {
    if (!t) { toast('No upcoming deadlines'); return; }
    useStore.setState({ pomoTaskId: t.id } as any);
    trackerToggle();
    toast(`Focusing on “${t.title}”`);
  };

  const statusOf = (t: Task) =>
    t.done ? { l: 'Completed', c: 'ok' } : t.pomodoros_spent > 0 ? { l: 'In progress', c: 'wip' } : { l: 'Pending', c: 'wait' };

  const cards = [
    { k: 'total', label: 'Total tasks', val: total, cap: `${active} open` },
    { k: 'done', label: 'Completed', val: done, cap: `${pct}% of all tasks` },
    { k: 'active', label: 'In progress', val: inProgress, cap: `${stats?.todayCount ?? 0} due today` },
    { k: 'flag', label: 'Flagged', val: flagged, cap: 'High priority, open' },
  ];
  const dateStr = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const share = (n: number) => `${total ? (n / total) * 100 : 0}%`;

  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1 className="dash-title">Dashboard</h1>
          <p className="dash-sub">{dateStr}</p>
        </div>
        <div className="dash-head-actions">
          <button className="btn-ghost" onClick={() => setAnalyticsOpen(true)}>
            <i className="fa-solid fa-chart-simple"></i> Insights
          </button>
          <button className="btn-primary" onClick={() => setTaskModalOpen(true)}>
            <i className="fa-solid fa-plus"></i> New task
          </button>
        </div>
      </header>

      <div className="dash-grid">
        {/* Stat cards: a label, a figure, what it compares to */}
        {cards.map((c) => (
          <button
            key={c.k}
            className="stat-card"
            onClick={() => setFilter(c.k === 'flag' ? 'high' : 'all')}
          >
            <span className="stat-label">{c.label}</span>
            <span className="stat-num">{c.val}</span>
            <span className="stat-cap">{c.cap}</span>
          </button>
        ))}

        {/* Main chart */}
        <section className="panel panel-analytics">
          <div className="panel-hd">
            <h3>Completed this week</h3>
            <span className="panel-meta">{weekDone} task{weekDone === 1 ? '' : 's'}</span>
          </div>
          <div className="bars">
            {week.map((d: any, i: number) => (
              <div className="bar-col" key={i}>
                <span className={`bar-val ${i === todayIdx ? 'is-today' : ''}`}>{d.count}</span>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${i === todayIdx ? 'peak' : ''} ${d.count === 0 ? 'empty' : ''}`}
                    style={{ height: `${Math.max(2, (d.count / maxCount) * 100)}%` }}
                  ></div>
                </div>
                <span className={`bar-lbl ${i === todayIdx ? 'is-today' : ''}`}>{(d.label || '')[0]}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Next deadline */}
        <section className="panel panel-reminder">
          <div className="panel-hd"><h3>Next deadline</h3></div>
          {reminder ? (
            <>
              <p className="rem-title">{reminder.title}</p>
              <p className="rem-time">
                {isOverdue(reminder.deadline) ? 'Overdue since ' : 'Due '}{fmtDate(reminder.deadline)}
              </p>
              <button className="btn-focus" onClick={() => startFocus(reminder)}>
                <i className="fa-solid fa-play"></i> Start focus
              </button>
            </>
          ) : (
            <p className="rem-empty">No upcoming deadlines</p>
          )}
        </section>

        {/* Ranked list */}
        <section className="panel panel-projects">
          <div className="panel-hd"><h3>Up next</h3></div>
          <ul className="proj-list">
            {projectList.length === 0 && <li className="proj-empty">No open tasks</li>}
            {projectList.map((t) => (
              <li key={t.id} className="proj-row" onClick={() => setTaskModalOpen(true, t)}>
                <span className={`proj-dot ${t.priority}`}></span>
                <div className="proj-info">
                  <span className="proj-name">{t.title}</span>
                  <span className="proj-date">{t.deadline ? `Due ${fmtDate(t.deadline)}` : 'No deadline'}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* Recent activity */}
        <section className="panel panel-activity">
          <div className="panel-hd"><h3>Recently added</h3></div>
          <ul className="act-list">
            {recent.length === 0 && <li className="proj-empty">Nothing here yet</li>}
            {recent.map((t) => {
              const st = statusOf(t);
              return (
                <li key={t.id} className="act-row" onClick={() => setTaskModalOpen(true, t)}>
                  <span className="act-ava">{initials(t.title)}</span>
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

        {/* Share of tasks by state: one stacked bar */}
        <section className="panel panel-progress">
          <div className="panel-hd">
            <h3>Progress</h3>
            <span className="panel-meta">{pct}% done</span>
          </div>
          <div className="stack" role="img" aria-label={`${done} completed, ${inProgress} in progress, ${pending} pending`}>
            <span className="stack-seg ok" style={{ width: share(done) }}></span>
            <span className="stack-seg wip" style={{ width: share(inProgress) }}></span>
            <span className="stack-seg wait" style={{ width: share(pending) }}></span>
          </div>
          <ul className="stack-legend">
            <li><i className="dot ok"></i>Completed<b>{done}</b></li>
            <li><i className="dot wip"></i>In progress<b>{inProgress}</b></li>
            <li><i className="dot wait"></i>Pending<b>{pending}</b></li>
          </ul>
        </section>

        {/* Timer */}
        <section className={`panel panel-tracker ${running ? 'live' : ''}`}>
          <div className="tracker-hd">
            <span>{mode === 'break' ? 'Break' : 'Focus timer'}</span>
            {running && <span className="live-dot"><i></i>Running</span>}
          </div>
          <div className="tracker-time">{fmt(timeLeft)}</div>
          <div className="tracker-ctrls">
            <button className="trk-btn" onClick={trackerToggle} title="Play / Pause" aria-label={running ? 'Pause' : 'Start'}>
              <i className={`fa-solid ${running ? 'fa-pause' : 'fa-play'}`}></i>
            </button>
            <button className="trk-btn stop" onClick={trackerStop} title="Reset" aria-label="Reset">
              <i className="fa-solid fa-rotate-left"></i>
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
