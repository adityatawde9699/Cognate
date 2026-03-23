import { useStore } from '../store';
import { useEffect, useState } from 'react';
import { getStats } from '../db';

export function Sidebar() {
  const currentFilter = useStore((state) => state.currentFilter);
  const setFilter = useStore((state) => state.setFilter);
  const tasks = useStore((state) => state.currentTasks);

  const [stats, setStats] = useState({
    done: 0, streak: 0, focusHrs: 0, urgent: 0
  });

  // Calculate badges on the fly from Zustand tasks
  const allCount = tasks.length;
  const d = new Date();
  const todayStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const todayCount = tasks.filter(t => t.deadline === todayStr).length;
  const highCount = tasks.filter((t: any) => t.priority === 'high' && !t.done).length;

  // Calculate generic tags and tagCounts
  const tagCounts: Record<string, number> = {};
  for (const t of tasks) {
    if (!t.done) {
      for (const tag of (t.tags || [])) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }
  const tags = Object.keys(tagCounts).sort((a, b) => tagCounts[b] - tagCounts[a]);

  useEffect(() => {
    // Initial fetch of stats to replace local logic
    const fetchStats = async () => {
      try {
        const s = await getStats();
        setStats({
          done: s.done,
          streak: s.streak,
          focusHrs: s.focusHrs,
          urgent: s.urgent
        });
      } catch (e) {
        console.error("Failed to load stats", e);
      }
    };
    fetchStats();
  }, [tasks]); // Refresh stats when tasks change

  return (
    <aside className="sidebar">
      <nav className="nav" role="navigation">
        <button 
          className={`nav-btn ${currentFilter === 'all' ? 'active' : ''}`} 
          onClick={() => setFilter('all')}
        >
          <i className="fa-solid fa-table-list"></i>
          <span>All Tasks</span>
          <span className="badge">{allCount}</span>
        </button>
        <button 
          className={`nav-btn ${currentFilter === 'today' ? 'active' : ''}`} 
          onClick={() => setFilter('today')}
        >
          <i className="fa-solid fa-sun"></i>
          <span>Due Today</span>
          <span className="badge">{todayCount}</span>
        </button>
        <button 
          className={`nav-btn ${currentFilter === 'high' ? 'active' : ''}`} 
          onClick={() => setFilter('high')}
        >
          <i className="fa-solid fa-fire"></i>
          <span>High Priority</span>
          <span className="badge badge-red">{highCount}</span>
        </button>
        <button className="nav-btn" onClick={() => useStore.getState().setAnalyticsOpen(true)}>
          <i className="fa-solid fa-chart-column"></i>
          <span>Analytics</span>
        </button>
      </nav>

      <div className="tags-nav">
        {tags.length > 0 && <div className="tags-hd">Tags</div>}
        {tags.map(t => (
          <button 
            key={t}
            className={`tag-nav-btn ${currentFilter === `tag:${t}` ? 'active' : ''}`}
            onClick={() => setFilter(`tag:${t}`)}
          >
            <span className="tn-hash">#</span> {t}
            <span className="tn-count">{tagCounts[t]}</span>
          </button>
        ))}
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <i className="fa-solid fa-circle-check sc-icon green"></i>
          <span className="sc-val">{stats.done}</span>
          <span className="sc-lbl">Done</span>
        </div>
        <div className="stat-card">
          <i className="fa-solid fa-fire-flame-curved sc-icon orange"></i>
          <span className="sc-val">{stats.streak}</span>
          <span className="sc-lbl">Streak</span>
        </div>
        <div className="stat-card">
          <i className="fa-solid fa-stopwatch sc-icon yellow"></i>
          <span className="sc-val">{stats.focusHrs}</span>
          <span className="sc-lbl">Focus hrs</span>
        </div>
        <div className="stat-card">
          <i className="fa-solid fa-triangle-exclamation sc-icon red"></i>
          <span className="sc-val">{stats.urgent}</span>
          <span className="sc-lbl">Urgent</span>
        </div>
      </div>

      <button className="btn-add" onClick={() => useStore.getState().setTaskModalOpen(true)}>
        <i className="fa-solid fa-plus"></i>
        <span>New Task</span>
        <kbd className="shortcut-key">N</kbd>
      </button>
    </aside>
  );
}
