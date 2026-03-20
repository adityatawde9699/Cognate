import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

export function Titlebar() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    // Basic theme initialization (you could wire this to getSetting from db.js later)
    const isDark = document.body.classList.contains('dark-theme');
    setTheme(isDark ? 'dark' : 'light');
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    if (newTheme === 'dark') {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }
    setTheme(newTheme);
  };

  const handleMinimize = async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await getCurrentWindow().minimize();
      }
    } catch(e) { console.error(e); }
  };

  const handleMaximize = async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await getCurrentWindow().toggleMaximize();
      }
    } catch(e) { console.error(e); }
  };

  const handleClose = async () => {
    try {
      if (window.__TAURI_INTERNALS__) {
        await getCurrentWindow().close();
      }
    } catch(e) { console.error(e); }
  };

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-brand" data-tauri-drag-region>
        <span className="tb-emoji">🧠</span>
        <span className="tb-name">Cognote</span>
      </div>
      <div className="tb-win-controls">
        <button className="tb-btn" title="Toggle theme (T)" aria-label="Toggle dark/light theme" onClick={toggleTheme}>
          <i className="fa-solid fa-circle-half-stroke"></i>
        </button>
        <button className="tb-btn" title="Settings" aria-label="Open settings">
          <i className="fa-solid fa-gear"></i>
        </button>
        <button className="tb-btn" title="Keyboard shortcuts (?)" aria-label="View keyboard shortcuts">
          <i className="fa-solid fa-keyboard"></i>
        </button>
        <button className="tb-btn wc" title="Minimize" aria-label="Minimize application" onClick={handleMinimize}>
          <i className="fa-solid fa-minus"></i>
        </button>
        <button className="tb-btn wc" title="Maximize" aria-label="Maximize application" onClick={handleMaximize}>
          <i className="fa-regular fa-square"></i>
        </button>
        <button className="tb-btn wc danger" title="Close" aria-label="Close application" onClick={handleClose}>
          <i className="fa-solid fa-xmark"></i>
        </button>
      </div>
    </header>
  );
}
