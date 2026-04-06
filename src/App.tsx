import { Board } from './components/Board';
import { Pomodoro } from './components/Pomodoro';
import { Analytics } from './components/Analytics';
import { Titlebar } from './components/Titlebar';
import { Sidebar } from './components/Sidebar';
import { TaskModal } from './components/Modals/TaskModal';
import { SettingsModal } from './components/Modals/SettingsModal';
import { Toast } from './components/Toast';
import { useStore } from './store';
import { useShortcuts } from './hooks/useShortcuts';
import { useTheme } from './hooks/useTheme';
import { useTasks } from './hooks/useTasks';

function App() {
  const { appError, setSettingsModalOpen } = useStore();
  useTheme(); // Initialize theme
  useShortcuts(); // Initialize global shortcuts
  useTasks(); // Hydrate tasks from DB at app root

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

  return (
    <>
      <Titlebar />
      
      <div className="layout">
        <Sidebar />

        <main className="main" id="mainBoard">
          <div className="toolbar">
            <div className="search-wrap">
              <i className="fa-solid fa-magnifying-glass"></i>
              <input 
                id="searchInput" 
                type="search" 
                placeholder="Search tasks… ( / )" 
                autoComplete="off" 
                onChange={(e) => useStore.getState().setSearchQuery(e.target.value)}
              />
              <kbd className="shortcut-key ghost" id="searchKbd">/</kbd>
            </div>

            <Pomodoro />
            
            <button className="btn-icon settings-btn-top" onClick={() => setSettingsModalOpen(true)}>
              <i className="fa-solid fa-gear"></i>
            </button>
          </div>

          <Board />
        </main>
        
        <Analytics />
        
        <TaskModal />
        <SettingsModal />
      </div>

      <Toast />
    </>
  );
}

export default App;
