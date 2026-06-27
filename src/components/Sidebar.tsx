import { useStore } from '../store';
import { Pomodoro } from './Pomodoro';
import { addProject, removeProject } from '../services/taskService';

const PROJ_COLORS = ['#34d399', '#0ea5e9', '#a78bfa', '#f59e0b', '#f472b6', '#22d3ee'];

function todayString() {
  const d = new Date();
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

export function Sidebar() {
  const currentFilter = useStore((state) => state.currentFilter);
  const setFilter = useStore((state) => state.setFilter);
  const tasks = useStore((state) => state.currentTasks);
  const setAnalyticsOpen = useStore((state) => state.setAnalyticsOpen);
  const setSettingsModalOpen = useStore((state) => state.setSettingsModalOpen);
  const setTaskModalOpen = useStore((state) => state.setTaskModalOpen);
  const setGenerateModalOpen = useStore((state) => state.setGenerateModalOpen);
  const projects = useStore((state) => state.projects);

  const todayStr = todayString();
  const weekEnd = new Date();
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr =
    weekEnd.getFullYear() +
    '-' +
    String(weekEnd.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(weekEnd.getDate()).padStart(2, '0');

  const open = tasks.filter((t) => !t.done);
  const inboxCount = open.length;
  const todayCount = open.filter((t) => t.deadline === todayStr).length;
  const weekCount = open.filter(
    (t) => t.deadline && t.deadline >= todayStr && t.deadline <= weekEndStr
  ).length;
  const flaggedCount = open.filter((t) => t.priority === 'high').length;

  // Per-project open-task counts
  const projectCounts: Record<string, number> = {};
  for (const t of open) {
    if (t.project_id) projectCounts[t.project_id] = (projectCounts[t.project_id] || 0) + 1;
  }

  const handleAddProject = async () => {
    const name = window.prompt('Project name')?.trim();
    if (name) await addProject(name, PROJ_COLORS[projects.length % PROJ_COLORS.length]);
  };

  const handleRemoveProject = async (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (window.confirm(`Delete project "${name}"? Its tasks are kept and unassigned.`)) {
      if (currentFilter === `project:${id}`) setFilter('all');
      await removeProject(id);
    }
  };

  const navItems: { id: string; label: string; icon: string; count: number; danger?: boolean }[] = [
    { id: 'plan', label: 'Plan', icon: 'fa-wand-magic-sparkles', count: 0 },
    { id: 'dashboard', label: 'Dashboard', icon: 'fa-table-columns', count: 0 },
    { id: 'all', label: 'Tasks', icon: 'fa-inbox', count: inboxCount },
    { id: 'today', label: 'Today', icon: 'fa-sun', count: todayCount },
    { id: 'week', label: 'This Week', icon: 'fa-calendar-week', count: weekCount },
    { id: 'high', label: 'Flagged', icon: 'fa-flag', count: flaggedCount, danger: true },
  ];

  return (
    <aside className="sidebar">
      <div className="ws-label">Workspace</div>

      <nav className="nav" role="navigation">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-btn ${currentFilter === item.id ? 'active' : ''}`}
            onClick={() => setFilter(item.id)}
          >
            <i className={`fa-solid ${item.icon}`}></i>
            <span className="nav-label">{item.label}</span>
            {item.count > 0 && (
              <span className={`nav-count ${item.danger ? 'is-danger' : ''}`}>{item.count}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="nav-section">
        <div className="nav-section-hd">
          <span>Projects</span>
          <button className="nav-section-add" title="New project" onClick={handleAddProject}>
            <i className="fa-solid fa-plus"></i>
          </button>
        </div>
        {projects.length === 0 ? (
          <p className="nav-empty">Create a project to group tasks.</p>
        ) : (
          projects.map((p) => (
            <button
              key={p.id}
              className={`project-btn ${currentFilter === `project:${p.id}` ? 'active' : ''}`}
              onClick={() => setFilter(`project:${p.id}`)}
            >
              <span className="project-dot" style={{ background: p.color || 'var(--accent)' }}></span>
              <span className="project-label">{p.name}</span>
              {projectCounts[p.id] > 0 && <span className="nav-count">{projectCounts[p.id]}</span>}
              <span className="project-del" title="Delete project" onClick={(e) => handleRemoveProject(p.id, p.name, e)}>
                <i className="fa-solid fa-xmark"></i>
              </span>
            </button>
          ))
        )}
      </div>

      <div className="sidebar-dock">
        <div className="dock-links">
          <button className="dock-link" onClick={() => setAnalyticsOpen(true)}>
            <i className="fa-solid fa-chart-pie"></i>
            <span>Insights</span>
          </button>
          <button className="dock-link" onClick={() => setSettingsModalOpen(true)}>
            <i className="fa-solid fa-gear"></i>
            <span>Settings</span>
          </button>
        </div>

        <button
          className={`dock-link ${currentFilter === 'trash' ? 'active' : ''}`}
          onClick={() => setFilter('trash')}
        >
          <i className="fa-solid fa-trash-can"></i>
          <span>Trash</span>
        </button>

        <Pomodoro />

        <button className="btn-generate" onClick={() => setGenerateModalOpen(true)}>
          <i className="fa-solid fa-wand-magic-sparkles"></i>
          <span>Generate tasks</span>
        </button>

        <button className="btn-add" onClick={() => setTaskModalOpen(true)}>
          <i className="fa-solid fa-plus"></i>
          <span>New Task</span>
          <kbd className="shortcut-key">N</kbd>
        </button>
      </div>
    </aside>
  );
}
