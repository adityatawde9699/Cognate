import { useMemo } from 'react';
import { useStore, Task } from '../store';
import type { AiQuery } from '../services/aiService';

/** Apply a structured AI predicate to a task list. Exported for testing. */
export function applyAiQuery(tasks: Task[], q: AiQuery, todayStr: string): Task[] {
  const daysUntil = (deadline: string): number =>
    Math.round((new Date(deadline + 'T00:00:00').getTime() - new Date(todayStr + 'T00:00:00').getTime()) / 86400000);

  return tasks.filter((t) => {
    if (q.done !== undefined && t.done !== q.done) return false;
    if (q.priority && t.priority !== q.priority) return false;
    if (q.tag && !t.tags?.some((tag) => tag.toLowerCase() === q.tag!.toLowerCase())) return false;
    if (q.hasDeadline !== undefined && Boolean(t.deadline) !== q.hasDeadline) return false;
    if (q.overdue && !(t.deadline && t.deadline < todayStr && !t.done)) return false;
    if (q.dueWithinDays !== undefined) {
      if (!t.deadline) return false;
      const d = daysUntil(t.deadline);
      if (d < 0 || d > q.dueWithinDays) return false;
    }
    if (q.minImportance !== undefined && t.importance < q.minImportance) return false;
    if (q.maxEffort !== undefined && t.effort > q.maxEffort) return false;
    if (q.untouched && !(!t.done && (t.pomodoros_spent || 0) === 0)) return false;
    if (q.textIncludes) {
      const needle = q.textIncludes.toLowerCase();
      const hay = `${t.title} ${t.description} ${(t.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Custom hook that computes visible tasks from raw store state.
 * Uses `useMemo` so filtering + searching only re-runs when
 * `currentTasks`, `currentFilter`, or `searchQuery` actually change.
 */
export function useVisibleTasks(): Task[] {
  const currentTasks = useStore((s) => s.currentTasks);
  const currentFilter = useStore((s) => s.currentFilter);
  const searchQuery = useStore((s) => s.searchQuery);
  const aiQuery = useStore((s) => s.aiQuery);

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
    } else if (currentFilter === 'week') {
      const weekEnd = new Date(d);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekEndStr =
        weekEnd.getFullYear() +
        '-' +
        String(weekEnd.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(weekEnd.getDate()).padStart(2, '0');
      tasks = tasks.filter(
        (t) => t.deadline && t.deadline >= todayStr && t.deadline <= weekEndStr
      );
    } else if (currentFilter === 'high') {
      tasks = tasks.filter((t) => t.priority === 'high' && !t.done);
    } else if (currentFilter.startsWith('tag:')) {
      const tag = currentFilter.substring(4);
      tasks = tasks.filter((t) => t.tags?.includes(tag));
    }

    // ── Apply AI predicate (natural-language query) ──────
    if (aiQuery) {
      tasks = applyAiQuery(tasks, aiQuery, todayStr);
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
  }, [currentTasks, currentFilter, searchQuery, aiQuery]);
}
