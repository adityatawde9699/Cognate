import { useEffect } from 'react';
import { useStore } from '../store';
import { useTheme } from './useTheme';
import { undoLast, redoLast } from '../services/taskService';
import { toast } from '../utils/toast';

export function useShortcuts() {
  const { setFilter, setTaskModalOpen } = useStore();
  const { toggleTheme } = useTheme();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      const inInput = ['input', 'textarea'].includes(tag || '');

      // ⌘K / Ctrl+K — command palette (works even from inputs)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const open = useStore.getState().isCommandOpen;
        useStore.getState().setCommandOpen(!open);
        return;
      }

      // ⌘Z / Ctrl+Z — undo; ⌘⇧Z / Ctrl+Y — redo (work even from inputs,
      // except while typing in a text field, where the browser owns undo).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z') && !inInput) {
        e.preventDefault();
        if (e.shiftKey) {
          void redoLast().then((label) => label && toast(`Redid: ${label}`));
        } else {
          void undoLast().then((label) => toast(label ? `Undid: ${label}` : 'Nothing to undo'));
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y') && !inInput) {
        e.preventDefault();
        void redoLast().then((label) => label && toast(`Redid: ${label}`));
        return;
      }

      if (e.key === 'Escape') {
        useStore.getState().setCommandOpen(false);
        useStore.getState().setTaskModalOpen(false);
        useStore.getState().setSettingsModalOpen(false);
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        return;
      }
      if (inInput) return;

      switch (e.key) {
        case 'n': case 'N': 
          setTaskModalOpen(true); 
          break;
        case '/': 
          e.preventDefault(); 
          document.getElementById('searchInput')?.focus(); 
          break;
        case '1': setFilter('all'); break;
        case '2': setFilter('today'); break;
        case '3': setFilter('week'); break;
        case '4': setFilter('high'); break;
        // case 'a': case 'A': toggleAnalytics(); break; // TODO if you have analytics panel
        case 't': case 'T': toggleTheme(); break;
        // case '?': toggleShortcutsHelp(); break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setFilter, setTaskModalOpen, toggleTheme]);
}
