import { useEffect } from 'react';
import { useStore, Task } from '../store';
import { getAllTasks, initDb } from '../db';

/**
 * Custom hook to initialize the database, load tasks on mount,
 * and synchronize with the Zustand store.
 */
export function useTasks() {
  const currentFilter = useStore((state) => state.currentFilter);
  const setTasks = useStore((state) => state.setTasks);

  useEffect(() => {
    let mounted = true;

    async function loadTasks() {
      try {
        await initDb();
        const data = await getAllTasks(currentFilter);
        if (mounted) setTasks(data as Task[]);
      } catch (err) {
        console.error("Failed to load tasks:", err);
      }
    }

    loadTasks();

    return () => {
      mounted = false;
    };
  }, [currentFilter, setTasks]);
}
