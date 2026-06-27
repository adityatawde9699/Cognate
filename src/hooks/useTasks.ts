import { useEffect } from 'react';
import { useStore } from '../store';
import { loadAllTasks, loadProjects, loadMilestones } from '../services/taskService';
import { loadCustomFieldDefs } from '../services/customFields';

/**
 * Custom hook to initialize the database, load tasks on mount,
 * and synchronize with the Zustand store when the filter changes.
 * 
 * Should be called once at the App root level.
 */
export function useTasks() {
  const currentFilter = useStore((state) => state.currentFilter);

  useEffect(() => {
    let mounted = true;

    async function hydrate() {
      if (mounted) {
        await loadAllTasks(currentFilter);
      }
    }

    hydrate();

    return () => {
      mounted = false;
    };
  }, [currentFilter]);

  // Load projects, milestones, and custom-field defs once at startup.
  useEffect(() => {
    loadProjects();
    loadMilestones();
    loadCustomFieldDefs();
  }, []);
}
