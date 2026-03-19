import { Board } from './components/Board';
import { Pomodoro } from './components/Pomodoro';
import { Analytics } from './components/Analytics';

function App() {
  // useEffect(() => {
  //   // Keep the old initApp call for now for reverse compatibility until we strip out all procedural JS
  //   // initApp();
  // }, []);

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

      <header className="titlebar" data-tauri-drag-region>
        <div className="tb-brand" data-tauri-drag-region>
          <span className="tb-emoji">🧠</span>
          <span className="tb-name">Cognote</span>
        </div>
        <div className="tb-win-controls">
          <button className="tb-btn" id="btnTheme" title="Toggle theme (T)" aria-label="Toggle dark/light theme">
            <i className="fa-solid fa-circle-half-stroke"></i>
          </button>
          <button className="tb-btn" id="btnSettings" title="Settings" aria-label="Open settings">
            <i className="fa-solid fa-gear"></i>
          </button>
          <button className="tb-btn" id="btnShortcuts" title="Keyboard shortcuts (?)" aria-label="View keyboard shortcuts">
            <i className="fa-solid fa-keyboard"></i>
          </button>
          <button className="tb-btn wc" id="btnMinimize" title="Minimize" aria-label="Minimize application">
            <i className="fa-solid fa-minus"></i>
          </button>
          <button className="tb-btn wc" id="btnMaximize" title="Maximize" aria-label="Maximize application">
            <i className="fa-regular fa-square"></i>
          </button>
          <button className="tb-btn wc danger" id="btnClose" title="Close" aria-label="Close application">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
      </header>
      
      <div className="layout">
        <aside className="sidebar">
          <nav className="nav" role="navigation">
            <button className="nav-btn active" data-filter="all" id="nav-all">
              <i className="fa-solid fa-table-list"></i>
              <span>All Tasks</span>
              <span className="badge" id="badge-all">0</span>
            </button>
            <button className="nav-btn" data-filter="today" id="nav-today">
              <i className="fa-solid fa-sun"></i>
              <span>Due Today</span>
              <span className="badge" id="badge-today">0</span>
            </button>
            <button className="nav-btn" data-filter="high" id="nav-high">
              <i className="fa-solid fa-fire"></i>
              <span>High Priority</span>
              <span className="badge badge-red" id="badge-high">0</span>
            </button>
            <button className="nav-btn" id="nav-analytics">
              <i className="fa-solid fa-chart-column"></i>
              <span>Analytics</span>
            </button>
          </nav>

          <div id="tagsNav" className="tags-nav"></div>

          <div className="stats-grid">
            <div className="stat-card">
              <i className="fa-solid fa-circle-check sc-icon green"></i>
              <span className="sc-val" id="stat-done">0</span>
              <span className="sc-lbl">Done</span>
            </div>
            <div className="stat-card">
              <i className="fa-solid fa-fire-flame-curved sc-icon orange"></i>
              <span className="sc-val" id="stat-streak">0</span>
              <span className="sc-lbl">Streak</span>
            </div>
            <div className="stat-card">
              <i className="fa-solid fa-stopwatch sc-icon yellow"></i>
              <span className="sc-val" id="stat-focus">0</span>
              <span className="sc-lbl">Focus hrs</span>
            </div>
            <div className="stat-card">
              <i className="fa-solid fa-triangle-exclamation sc-icon red"></i>
              <span className="sc-val" id="stat-urgent">0</span>
              <span className="sc-lbl">Urgent</span>
            </div>
          </div>

          <button className="btn-add" id="openModal">
            <i className="fa-solid fa-plus"></i>
            <span>New Task</span>
            <kbd className="shortcut-key">N</kbd>
          </button>
        </aside>

        <main className="main" id="mainBoard">
          <div className="toolbar">
            <div className="search-wrap">
              <i className="fa-solid fa-magnifying-glass"></i>
              <input id="searchInput" type="search" placeholder="Search tasks… ( / )" autoComplete="off" />
              <kbd className="shortcut-key ghost" id="searchKbd">/</kbd>
            </div>

            <Pomodoro />
          </div>

          <Board />
        </main>
        
        <Analytics />
        {/* Modals and settings hidden for now to get a clean mount */}
      </div>
    </>
  );
}

export default App;
