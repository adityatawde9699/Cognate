import { useEffect } from 'react';
import { useStore } from '../store';
import { useTheme } from './useTheme';

export function useShortcuts() {
  const { setFilter, setTaskModalOpen } = useStore();
  const { toggleTheme } = useTheme();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName?.toLowerCase();
      const inInput = ['input', 'textarea'].includes(tag || '');

      if (e.key === 'Escape') {
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
        case '3': setFilter('high'); break;
        // case 'a': case 'A': toggleAnalytics(); break; // TODO if you have analytics panel
        case 't': case 'T': toggleTheme(); break;
        // case '?': toggleShortcutsHelp(); break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [setFilter, setTaskModalOpen, toggleTheme]);
}
