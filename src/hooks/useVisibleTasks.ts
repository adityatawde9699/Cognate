import { useMemo } from 'react';
import { useStore, Task } from '../store';

/**
 * Custom hook that computes visible tasks from raw store state.
 * Uses `useMemo` so filtering + searching only re-runs when
 * `currentTasks`, `currentFilter`, or `searchQuery` actually change.
 */
export function useVisibleTasks(): Task[] {
  const currentTasks = useStore((s) => s.currentTasks);
  const currentFilter = useStore((s) => s.currentFilter);
  const searchQuery = useStore((s) => s.searchQuery);

  return useMemo(() => {
    let tasks = currentTasks;

    // ── Apply filter ─────────────────────────────────────
    const d = new Date();
    const todayStr =
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0');

    if (currentFilter === 'today') {
      tasks = tasks.filter((t) => t.deadline === todayStr);
    } else if (currentFilter === 'high') {
      tasks = tasks.filter((t) => t.priority === 'high' && !t.done);
    } else if (currentFilter.startsWith('tag:')) {
      const tag = currentFilter.substring(4);
      tasks = tasks.filter((t) => t.tags?.includes(tag));
    }

    // ── Apply search ─────────────────────────────────────
    if (!searchQuery) return tasks;

    const q = searchQuery.toLowerCase();
    return tasks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.tags?.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [currentTasks, currentFilter, searchQuery]);
}
