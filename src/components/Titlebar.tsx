import { useState, type MouseEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useStore } from '../store';
import { useTheme } from '../hooks/useTheme';
import { queryToPredicate } from '../services/aiService';
import { toast } from '../utils/toast';
import { Logo } from './Logo';
import { IS_TAURI } from '../db';

export function Titlebar() {
  const { theme, toggleTheme } = useTheme();
  const setSettingsModalOpen = useStore((state) => state.setSettingsModalOpen);
  const setSearchQuery = useStore((state) => state.setSearchQuery);
  const setFilter = useStore((state) => state.setFilter);
  const setAiQuery = useStore((state) => state.setAiQuery);
  const aiQueryLabel = useStore((state) => state.aiQueryLabel);
  const tasks = useStore((state) => state.currentTasks);

  const [value, setValue] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const runAiQuery = async () => {
    const q = value.trim();
    if (!q) return;
    setAiBusy(true);
    try {
      const knownTags = Array.from(new Set(tasks.flatMap((t) => t.tags || [])));
      const pred = await queryToPredicate(q, knownTags);
      if (!pred || Object.keys(pred).length === 0) {
        toast("Couldn't turn that into a filter — try rephrasing");
        return;
      }
      setFilter('all'); // show the board (also clears any prior AI query)
      setSearchQuery('');
      setAiQuery(pred, q);
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setAiBusy(false);
    }
  };

  const clearAiQuery = () => { setAiQuery(null); setSearchQuery(''); setValue(''); };

  // Frameless Tauri windows do not get native drag behavior automatically on
  // every platform/webview. Start the drag explicitly from non-interactive
  // title-bar areas so the window behaves like a normal desktop window.
  const dragWindow = async (e: MouseEvent<HTMLElement>) => {
    if (!(window as any).__TAURI_INTERNALS__) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select, textarea, a, [role="button"]')) return;
    try { await getCurrentWindow().startDragging(); } catch (error) { console.error(error); }
  };

  const toggleWindowSize = async () => {
    await winAction((w) => w.toggleMaximize());
  };

  const winAction = async (fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) => {
    try {
      if ((window as any).__TAURI_INTERNALS__) {
        await fn(getCurrentWindow());
      }
    } catch (e) { console.error(e); }
  };

  return (
    <header
      className={`cmdbar ${IS_TAURI ? 'is-native' : 'is-web'}`}
      data-tauri-drag-region
      onMouseDown={(e) => { if (e.button === 0) void dragWindow(e); }}
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement;
        if (!target.closest('button, input, select, textarea, a, [role="button"]')) void toggleWindowSize();
      }}
    >
      <div className="cmd-brand" data-tauri-drag-region>
        <Logo className="cmd-logo" />
      </div>

      <div className="cmd-center">
        <div className="cmd-search">
          <i className="fa-solid fa-magnifying-glass"></i>
          <input
            id="searchInput"
            aria-label="Search tasks"
            type="search"
            placeholder="Search tasks, or ask in plain English…"
            autoComplete="off"
            value={value}
            onChange={(e) => {
              const query = e.target.value;
              setValue(query);
              setSearchQuery(query);
              if (query.trim() && ['plan', 'dashboard'].includes(useStore.getState().currentFilter)) setFilter('all');
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') runAiQuery(); }}
          />
          {value && <button className="cmd-clear" aria-label="Clear search" title="Clear search" onClick={clearAiQuery}>
            <i className="fa-solid fa-xmark" aria-hidden="true" />
          </button>}
          <button
            className="cmd-ask"
            title="Ask AI to filter (Enter)"
            aria-label="Ask AI to filter"
            disabled={aiBusy}
            onClick={runAiQuery}
          >
            <i className={`fa-solid ${aiBusy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
          </button>
          <kbd className="cmd-kbd">/</kbd>
        </div>
        {aiQueryLabel && (
          <button className="cmd-aichip" onClick={clearAiQuery} title="Clear AI filter">
            <i className="fa-solid fa-wand-magic-sparkles"></i>
            <span>{aiQueryLabel}</span>
            <i className="fa-solid fa-xmark"></i>
          </button>
        )}
      </div>

      <div className="cmd-right">
        <button className="cmd-btn cmdk-trigger" title="Command palette (⌘K)" aria-label="Open command palette" onClick={() => useStore.getState().setCommandOpen(true)}>
          <i className="fa-solid fa-bolt"></i>
        </button>
        <button className="cmd-btn" title="Toggle theme (T)" aria-label="Toggle dark/light theme" onClick={toggleTheme}>
          <i className={`fa-solid ${theme === 'light' ? 'fa-moon' : 'fa-sun'}`}></i>
        </button>
        <button className="cmd-btn" title="Settings" aria-label="Open settings" onClick={() => setSettingsModalOpen(true)}>
          <i className="fa-solid fa-gear"></i>
        </button>

        {IS_TAURI && (<>
          <span className="cmd-sep" aria-hidden="true"></span>

          <button className="cmd-btn wc" title="Minimize" aria-label="Minimize" onClick={() => winAction((w) => w.minimize())}>
            <i className="fa-solid fa-minus"></i>
          </button>
          <button className="cmd-btn wc" title="Maximize" aria-label="Maximize" onClick={toggleWindowSize}>
            <i className="fa-regular fa-square"></i>
          </button>
          <button className="cmd-btn wc danger" title="Close to tray" aria-label="Close to tray" onClick={() => winAction((w) => w.close())}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </>)}
      </div>
    </header>
  );
}
