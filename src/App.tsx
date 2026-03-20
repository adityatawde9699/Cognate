import { Board } from './components/Board';
import { Pomodoro } from './components/Pomodoro';
import { Analytics } from './components/Analytics';
import { Titlebar } from './components/Titlebar';
import { Sidebar } from './components/Sidebar';
import { TaskModal } from './components/Modals/TaskModal';
import { SettingsModal } from './components/Modals/SettingsModal';
import { useStore } from './store';
import { useShortcuts } from './hooks/useShortcuts';
import { useTheme } from './hooks/useTheme';

function App() {
  const { setSettingsModalOpen } = useStore();
  useTheme(); // Initialize theme
  useShortcuts(); // Initialize global shortcuts

  return (
    <>
      <div id="errorScreen" className="error-screen hidden">
        <div className="err-box">
          <i className="fa-solid fa-triangle-exclamation"></i>
          <h2>Failed to start Cognote</h2>
          <p id="errMsg"></p>
          <button onClick={() => window.location.reload()} className="btn-primary">Retry</button>
        </div>
      </div>

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
    </>
  );
}

export default App;
