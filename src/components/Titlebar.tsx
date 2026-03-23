import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useStore } from '../store';

export function Titlebar() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const setSettingsModalOpen = useStore((state) => state.setSettingsModalOpen);

  useEffect(() => {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    setTheme(currentTheme as 'light' | 'dark');
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    if (newTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    setTheme(newTheme);
  };

  const handleMinimize = async () => {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        await getCurrentWindow().minimize();
      }
    } catch(e) { console.error(e); }
  };

  const handleMaximize = async () => {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        await getCurrentWindow().toggleMaximize();
      }
    } catch(e) { console.error(e); }
  };

  const handleClose = async () => {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
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
        <button className="tb-btn" title="Settings" aria-label="Open settings" onClick={() => setSettingsModalOpen(true)}>
          <i className="fa-solid fa-gear"></i>
        </button>
        <button className="tb-btn" title="Keyboard shortcuts (?)" aria-label="View keyboard shortcuts" onClick={() => alert('Keyboard shortcuts:\\n? - Show this menu\\nN - New Task\\nT - Toggle Theme')}>
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
