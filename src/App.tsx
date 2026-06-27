import { lazy, Suspense } from 'react';
import { Board } from './components/Board';
import { MilestoneStrip } from './components/MilestoneStrip';
import { PlanView } from './components/PlanView';
import { Titlebar } from './components/Titlebar';
import { Sidebar } from './components/Sidebar';
import { TaskModal } from './components/Modals/TaskModal';
import { CommandPalette } from './components/CommandPalette';
import { FocusMode } from './components/FocusMode';
import { Onboarding } from './components/Onboarding';
import { Toast } from './components/Toast';

// Code-split (Act 5 perf): load these only when their view/overlay opens, so
// the default Plan landing ships a smaller, faster initial bundle.
const ListView = lazy(() => import('./components/ListView').then((m) => ({ default: m.ListView })));
const TableView = lazy(() => import('./components/TableView').then((m) => ({ default: m.TableView })));
const CalendarView = lazy(() => import('./components/CalendarView').then((m) => ({ default: m.CalendarView })));
const TimelineView = lazy(() => import('./components/TimelineView').then((m) => ({ default: m.TimelineView })));
const Dashboard = lazy(() => import('./components/Dashboard').then((m) => ({ default: m.Dashboard })));
const TrashView = lazy(() => import('./components/TrashView').then((m) => ({ default: m.TrashView })));
const Analytics = lazy(() => import('./components/Analytics').then((m) => ({ default: m.Analytics })));
const SettingsModal = lazy(() => import('./components/Modals/SettingsModal').then((m) => ({ default: m.SettingsModal })));
const GenerateTasksModal = lazy(() => import('./components/Modals/GenerateTasksModal').then((m) => ({ default: m.GenerateTasksModal })));
const TemplatesModal = lazy(() => import('./components/Modals/TemplatesModal').then((m) => ({ default: m.TemplatesModal })));

import { useStore } from './store';
import { useShortcuts } from './hooks/useShortcuts';
import { useTheme } from './hooks/useTheme';
import { useTasks } from './hooks/useTasks';
import { usePomodoroConfig } from './hooks/usePomodoroConfig';
import { useDeadlineWatcher } from './hooks/useDeadlineWatcher';
import { useDataSafety } from './hooks/useDataSafety';
import { useAutoUpdate } from './hooks/useAutoUpdate';
import { useAutoReflow } from './hooks/useAutoReflow';
import { useAutoSync } from './hooks/useAutoSync';
import { useAutoShareSync } from './hooks/useAutoShareSync';
import { useMorningBrief } from './hooks/useMorningBrief';

const VIEW_META: Record<string, { title: string; sub: string }> = {
  all: { title: 'Inbox', sub: 'Everything on your plate, in one place.' },
  today: { title: 'Today', sub: 'Due before the day is out.' },
  week: { title: 'This Week', sub: 'Landing in the next seven days.' },
  high: { title: 'Flagged', sub: 'High-priority work that needs you first.' },
};

function viewMeta(filter: string) {
  if (filter.startsWith('tag:')) {
    const tag = filter.slice(4);
    return { title: `#${tag}`, sub: `Tasks tagged ${tag}.` };
  }
  return VIEW_META[filter] ?? VIEW_META.all;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Burning the midnight oil';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function App() {
  const { appError, currentFilter, setTaskModalOpen } = useStore();
  const tasks = useStore((s) => s.currentTasks);
  const canvasView = useStore((s) => s.canvasView);
  const setCanvasView = useStore((s) => s.setCanvasView);
  const isAnalyticsOpen = useStore((s) => s.isAnalyticsOpen);
  const isSettingsModalOpen = useStore((s) => s.isSettingsModalOpen);
  const isGenerateModalOpen = useStore((s) => s.isGenerateModalOpen);
  const templatesMode = useStore((s) => s.templatesMode);
  useTheme(); // Initialize theme
  useShortcuts(); // Initialize global shortcuts
  useTasks(); // Hydrate tasks from DB at app root
  usePomodoroConfig(); // Push Pomodoro settings into the Rust timer
  useDeadlineWatcher(); // Notify on tasks due today / overdue
  useDataSafety(); // Integrity check + daily auto-backup at boot
  useAutoUpdate(); // Check for a newer signed release at boot
  useAutoReflow(); // Re-plan today when a meeting lands or a block slips
  useAutoSync(); // Push/pull encrypted ops to the relay when live sync is on
  useAutoShareSync(); // Sync shared projects (signed ops, per-share E2E rooms)
  useMorningBrief(); // Proactive once-a-day morning brief (Act 4)

  // ── Fatal error screen (React-managed) ──────────────
  if (appError) {
    return (
      <div className="error-screen">
        <div className="err-box">
          <i className="fa-solid fa-triangle-exclamation"></i>
          <h2>Failed to start Cognate</h2>
          <p>{appError}</p>
          <button onClick={() => window.location.reload()} className="btn-primary">Retry</button>
        </div>
      </div>
    );
  }

  const meta = viewMeta(currentFilter);

  const total = tasks.length;
  const done = tasks.filter((t) => t.done).length;
  const active = total - done;
  const focus = tasks.reduce((n, t) => n + (t.pomodoros_spent || 0), 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const dateStr = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  });

  return (
    <div className="app-shell">
      <Titlebar />

      <div className="layout">
        <Sidebar />

        <main className="main" id="mainBoard">
          <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
          {currentFilter === 'plan' ? (
            <PlanView />
          ) : currentFilter === 'dashboard' ? (
            <Dashboard />
          ) : currentFilter === 'trash' ? (
            <TrashView />
          ) : (
          <>
          <header className="canvas-header">
            <div className="canvas-heading">
              <div className="canvas-eyebrow">
                <i className="fa-regular fa-sun"></i>
                {greeting()} · {dateStr}
              </div>
              <h1 className="canvas-title">{meta.title}</h1>
              <p className="canvas-sub">{meta.sub}</p>
            </div>
            <div className="canvas-actions">
              <div className="view-switch" role="tablist" aria-label="View">
                {([
                  ['board', 'fa-table-columns', 'Board'],
                  ['list', 'fa-list-ul', 'List'],
                  ['table', 'fa-table-list', 'Table'],
                  ['calendar', 'fa-calendar-days', 'Calendar'],
                  ['timeline', 'fa-bars-staggered', 'Timeline'],
                ] as const).map(([v, icon, label]) => (
                  <button
                    key={v}
                    className={`view-tab ${canvasView === v ? 'active' : ''}`}
                    onClick={() => setCanvasView(v)}
                    title={label}
                    aria-selected={canvasView === v}
                  >
                    <i className={`fa-solid ${icon}`}></i>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <button className="btn-primary" onClick={() => setTaskModalOpen(true)}>
                <i className="fa-solid fa-plus"></i>
                <span>New task</span>
              </button>
            </div>
          </header>

          <div className="canvas-deck">
            <div className="deck-stats">
              <div className="deck-stat">
                <span className="v">{active}</span>
                <span className="l">Active</span>
              </div>
              <div className="deck-stat">
                <span className="v" style={{ color: 'var(--accent)' }}>{done}</span>
                <span className="l">Completed</span>
              </div>
              <div className="deck-stat">
                <span className="v">{focus}</span>
                <span className="l">Focus sessions</span>
              </div>
            </div>
            <div className="deck-progress" title={`${pct}% complete`}>
              <div className="deck-track">
                <div className="deck-fill" style={{ width: `${pct}%` }}></div>
              </div>
              <span className="deck-pct">{pct}%</span>
            </div>
          </div>

          <MilestoneStrip />

          {canvasView === 'list' ? <ListView />
            : canvasView === 'table' ? <TableView />
            : canvasView === 'calendar' ? <CalendarView />
            : canvasView === 'timeline' ? <TimelineView />
            : <Board />}
          </>
          )}
          </Suspense>
        </main>
      </div>

      {/* Overlays — heavy ones are code-split and mounted only when opened. */}
      <Suspense fallback={null}>
        {isAnalyticsOpen && <Analytics />}
        {isSettingsModalOpen && <SettingsModal />}
        {isGenerateModalOpen && <GenerateTasksModal />}
        {templatesMode && <TemplatesModal />}
      </Suspense>
      <TaskModal />
      <CommandPalette />
      <FocusMode />
      <Onboarding />

      <Toast />
    </div>
  );
}

export default App;
