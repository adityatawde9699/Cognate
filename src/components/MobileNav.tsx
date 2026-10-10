import { useStore } from '../store';

/** Keep the main destinations reachable when the desktop sidebar is hidden. */
export function MobileNav() {
  const filter = useStore(s => s.currentFilter);
  const setFilter = useStore(s => s.setFilter);
  const openTask = useStore(s => s.setTaskModalOpen);
  const openSettings = useStore(s => s.setSettingsModalOpen);
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {[['plan', 'Plan', 'fa-calendar-check'], ['all', 'Tasks', 'fa-inbox']].map(([id, label, icon]) => (
        <button key={id} className={`mobile-nav-btn ${filter === id ? 'active' : ''}`}
          aria-current={filter === id ? 'page' : undefined} onClick={() => setFilter(id)}>
          <i className={`fa-solid ${icon}`} aria-hidden="true" /><span>{label}</span>
        </button>
      ))}
      <button className="mobile-nav-btn mobile-capture" onClick={() => openTask(true)} aria-label="New task">
        <i className="fa-solid fa-plus" aria-hidden="true" /><span>Capture</span>
      </button>
      <button className={`mobile-nav-btn ${filter === 'dashboard' ? 'active' : ''}`}
        aria-current={filter === 'dashboard' ? 'page' : undefined} onClick={() => setFilter('dashboard')}>
        <i className="fa-solid fa-chart-simple" aria-hidden="true" /><span>Overview</span>
      </button>
      <button className="mobile-nav-btn" onClick={() => openSettings(true)}>
        <i className="fa-solid fa-gear" aria-hidden="true" /><span>Settings</span>
      </button>
    </nav>
  );
}
