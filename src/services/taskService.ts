/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/taskService.ts — CQRS Persistence Pipeline
   Reads:  DB → Zustand (on mount / filter change)
   Writes: Optimistic Zustand update → async DB → rollback on failure
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { useStore, Task } from '../store';
import {
  getAllTasks,
  createTask as dbCreateTask,
  updateTask as dbUpdateTask,
  deleteTask as dbDeleteTask,
  toggleTask as dbToggleTask,
  updateSortOrders as dbUpdateSortOrders,
  addPomodoro as dbAddPomodoro,
  initDb,
} from '../db';

// ── Helpers ──────────────────────────────────────────────

/** Snapshot the current tasks array for rollback purposes. */
function snapshot(): Task[] {
  return [...useStore.getState().currentTasks];
}

/** Restore tasks from a snapshot and surface the error. */
function rollback(saved: Task[], error: unknown, context: string) {
  console.error(`[taskService] ${context} failed:`, error);
  useStore.getState().setTasks(saved);
  useStore.getState().setAppError(
    `Failed to ${context}. Your change was reverted.`
  );
}

// ── Reads ────────────────────────────────────────────────

/**
 * Initialize the database (seed if needed) then load all tasks
 * for the given filter into the Zustand store.
 */
export async function loadAllTasks(filter: string = 'all'): Promise<void> {
  try {
    await initDb();
    const tasks = await getAllTasks(filter);
    useStore.getState().setTasks(tasks as Task[]);
  } catch (error) {
    console.error('[taskService] loadAllTasks failed:', error);
    useStore.getState().setAppError('Failed to load tasks from database.');
  }
}

// ── Writes (Optimistic UI) ───────────────────────────────

/**
 * Create a new task: optimistic insert → DB persist → rollback on failure.
 */
export async function addTask(data: {
  title: string;
  description: string;
  deadline: string;
  tags: string[];
  importance: number;
  effort: number;
}): Promise<void> {
  const saved = snapshot();

  try {
    // DB write first to get the full task object with computed fields (id, priority, etc.)
    const task = await dbCreateTask(data);

    // Then update Zustand with the authoritative task from DB
    useStore.getState().addTaskOptimistic(task as Task);
  } catch (error) {
    rollback(saved, error, 'create task');
  }
}

/**
 * Update an existing task: optimistic update → DB persist → rollback on failure.
 */
export async function editTask(
  id: string,
  data: {
    title: string;
    description: string;
    deadline: string;
    tags: string[];
    importance: number;
    effort: number;
  }
): Promise<void> {
  const saved = snapshot();

  // Optimistic update with the data we have
  useStore.getState().updateTaskOptimistic(id, data as unknown as Partial<Task>);

  try {
    // Persist to DB and get the authoritative version (with recalculated priority)
    const updated = await dbUpdateTask(id, data);

    // Reconcile with DB result (priority may have changed)
    useStore.getState().updateTaskOptimistic(id, updated as Partial<Task>);
  } catch (error) {
    rollback(saved, error, 'update task');
  }
}

/**
 * Delete a task: optimistic removal → DB delete → rollback on failure.
 */
export async function removeTask(id: string): Promise<void> {
  const saved = snapshot();

  // Optimistic removal
  useStore.getState().removeTaskOptimistic(id);

  try {
    await dbDeleteTask(id);
  } catch (error) {
    rollback(saved, error, 'delete task');
  }
}

/**
 * Toggle task done/undone: optimistic toggle → DB update → rollback on failure.
 */
export async function toggleTaskDone(id: string): Promise<void> {
  const saved = snapshot();

  // Optimistic toggle
  useStore.getState().toggleTaskOptimistic(id);

  try {
    await dbToggleTask(id);
  } catch (error) {
    rollback(saved, error, 'toggle task');
  }
}

/**
 * Reorder tasks: optimistic reorder → DB persist → rollback on failure.
 */
export async function reorderTasks(orderedIds: string[]): Promise<void> {
  const saved = snapshot();

  // Optimistic reorder
  useStore.getState().reorderTasks(orderedIds);

  try {
    await dbUpdateSortOrders(orderedIds);
  } catch (error) {
    rollback(saved, error, 'reorder tasks');
  }
}

/**
 * Increment pomodoro count: optimistic update → DB persist → rollback on failure.
 */
export async function addPomodoroToTask(id: string): Promise<void> {
  const saved = snapshot();

  // Optimistic increment
  useStore.getState().incrementPomodoro(id);

  try {
    await dbAddPomodoro(id);
  } catch (error) {
    rollback(saved, error, 'add pomodoro');
  }
}
