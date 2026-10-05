/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/taskService.ts — CQRS Persistence Pipeline
   Reads:  DB → Zustand (on mount / filter change)
   Writes: Optimistic Zustand update → async DB → rollback on failure
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import {
    addPomodoro as dbAddPomodoro,
    createMilestone as dbCreateMilestone,
    createProject as dbCreateProject,
    createTask as dbCreateTask,
    deleteMilestone as dbDeleteMilestone,
    deleteProject as dbDeleteProject,
    deleteTask as dbDeleteTask,
    emptyTrash as dbEmptyTrash,
    getMilestones as dbGetMilestones,
    getProjects as dbGetProjects,
    getTrash as dbGetTrash,
    restoreTask as dbRestoreTask,
    softDeleteTask as dbSoftDeleteTask,
    toggleTask as dbToggleTask,
    updateMilestone as dbUpdateMilestone,
    updateProject as dbUpdateProject,
    updateSortOrders as dbUpdateSortOrders,
    updateTask as dbUpdateTask,
    getAllTasks,
    initDb,
} from '../db';
import { Project, Recurrence, Task, useStore } from '../store';
import { redo as historyRedo, undo as historyUndo, record } from './history';
import { ensureIdentity } from './identity';
export { nextDeadline } from './recurrenceRules';
import { notifyTaskComplete } from './webhookService';
import { toast } from '../utils/toast';

export interface TaskInput {
  title: string;
  description: string;
  deadline: string;
  tags: string[];
  importance: number;
  effort: number;
  project_id?: string | null;
  parent_id?: string | null;
  recurrence?: Recurrence;
  milestone_id?: string | null;
  custom_fields?: Record<string, string>;
  // Act 4: NL quick-add can seed a duration / energy estimate at creation.
  duration_min?: number;
  energy?: 'hi' | 'med' | 'lo';
}

// ── Helpers ──────────────────────────────────────────────

/** Snapshot the current tasks array for rollback purposes. */
function snapshot(): Task[] {
  return [...useStore.getState().currentTasks];
}

/** Restore tasks from a snapshot and surface the error. */
function rollback(saved: Task[], error: unknown, context: string) {
  console.error(`[taskService] ${context} failed:`, error);
  useStore.getState().setTasks(saved);
  toast(`Failed to ${context}. Your change was reverted.`);
}

/** Project a full Task back down to the editable input shape (for edit-undo). */
function taskToInput(t: Task): TaskInput {
  return {
    title: t.title,
    description: t.description,
    deadline: t.deadline,
    tags: t.tags,
    importance: t.importance,
    effort: t.effort,
    project_id: t.project_id,
    parent_id: t.parent_id,
    recurrence: t.recurrence,
    milestone_id: t.milestone_id,
    custom_fields: t.custom_fields,
  };
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
    // Identity warm-up is independent of the atomic task write path.
    if (filter === 'all') {
      void ensureIdentity(); // Act 3: mint/load this device's signing identity early.
    }
  } catch (error) {
    console.error('[taskService] loadAllTasks failed:', error);
    useStore.getState().setAppError('Failed to load tasks from database.');
  }
}

// ── Writes (Optimistic UI) ───────────────────────────────

/**
 * Create a new task: optimistic insert → DB persist → rollback on failure.
 * Returns the created task (or null on failure) so callers like NL quick-add
 * can schedule it.
 */
export async function addTask(data: TaskInput): Promise<Task | null> {
  const saved = snapshot();

  try {
    // DB write first to get the full task object with computed fields (id, priority, etc.)
    const task = (await dbCreateTask(data)) as Task;

    // Then update Zustand with the authoritative task from DB
    useStore.getState().addTaskOptimistic(task);


    // Inverse op: undo soft-deletes it (recoverable), redo restores it.
    record({
      label: 'Add task',
      undo: async () => {
        await dbSoftDeleteTask(task.id);
        useStore.getState().removeTaskOptimistic(task.id);
      },
      redo: async () => {
        await dbRestoreTask(task.id);
        useStore.getState().addTaskOptimistic(task);
      },
    });
    return task;
  } catch (error) {
    rollback(saved, error, 'create task');
    return null;
  }
}

/**
 * Update an existing task: optimistic update → DB persist → rollback on failure.
 */
export async function editTask(
  id: string,
  data: TaskInput
): Promise<void> {
  const saved = snapshot();
  const before = saved.find((t) => t.id === id);

  // Optimistic update with the data we have
  useStore.getState().updateTaskOptimistic(id, data as unknown as Partial<Task>);

  try {
    // Persist to DB and get the authoritative version (with recalculated priority)
    const updated = await dbUpdateTask(id, data);

    // Reconcile with DB result (priority may have changed)
    useStore.getState().updateTaskOptimistic(id, updated as Partial<Task>);


    // Inverse op: re-apply the prior field values (priority recomputes from them).
    if (before) {
      const beforeInput = taskToInput(before);
      record({
        label: 'Edit task',
        undo: async () => {
          const reverted = await dbUpdateTask(id, beforeInput);
          useStore.getState().updateTaskOptimistic(id, reverted as Partial<Task>);
        },
        redo: async () => {
          const reapplied = await dbUpdateTask(id, data);
          useStore.getState().updateTaskOptimistic(id, reapplied as Partial<Task>);
        },
      });
    }
  } catch (error) {
    rollback(saved, error, 'update task');
    throw error;
  }
}

/**
 * Delete a task: optimistic removal → DB delete → rollback on failure.
 */
const pendingMutations = new Set<Promise<void>>();
export function removeTask(id: string): Promise<void> {
  const command = removeTaskCommand(id);
  pendingMutations.add(command);
  command.finally(() => pendingMutations.delete(command));
  return command;
}
async function removeTaskCommand(id: string): Promise<void> {
  const saved = snapshot();
  const task = saved.find((t) => t.id === id);

  // Optimistic removal
  useStore.getState().removeTaskOptimistic(id);

  try {
    // Soft-delete: the task lands in Trash, recoverable from there or via undo.
    const when = new Date().toISOString();
    await dbSoftDeleteTask(id, when);


    if (task) {
      record({
        label: 'Delete task',
        undo: async () => {
          await dbRestoreTask(id);
          useStore.getState().addTaskOptimistic(task);
        },
        redo: async () => {
          await dbSoftDeleteTask(id);
          useStore.getState().removeTaskOptimistic(id);
        },
      });
    }
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
    const updated = await dbToggleTask(id);
    useStore.getState().updateTaskOptimistic(id, updated as Task);
    const task = useStore.getState().currentTasks.find((t) => t.id === id);
    if (task?.done) {
      // Announce newly-completed tasks to configured webhooks (fire-and-forget).
      void notifyTaskComplete(task);
      // Recurring tasks spawn their next occurrence on completion.
      if (task.recurrence && task.recurrence !== 'none') await loadAllTasks(useStore.getState().currentFilter);
    }

    // Inverse op flips the done state back; side effects (webhook, recurrence
    // spawn) are intentionally not replayed by undo/redo.
    const flip = async () => {
      await dbToggleTask(id);
      useStore.getState().toggleTaskOptimistic(id);
    };
    record({ label: 'Toggle task', undo: flip, redo: flip });
  } catch (error) {
    rollback(saved, error, 'toggle task');
  }
}

/** Create a subtask under a parent task. */
export async function addSubtask(parentId: string, title: string): Promise<void> {
  const parent = useStore.getState().currentTasks.find((t) => t.id === parentId);
  await addTask({
    title,
    description: '',
    deadline: '',
    tags: [],
    importance: 3,
    effort: 3,
    project_id: parent?.project_id ?? null,
    parent_id: parentId,
    recurrence: 'none',
  });
}

// ── Projects ─────────────────────────────────────────────

export async function loadProjects(): Promise<void> {
  try {
    const projects = await dbGetProjects();
    useStore.getState().setProjects(projects as any);
  } catch (e) {
    console.error('[taskService] loadProjects failed:', e);
  }
}

export async function addProject(name: string, color = ''): Promise<Project | null> {
  try {
    const project = await dbCreateProject(name.trim(), color);
    await loadProjects();
    return project;
  } catch (e) {
    console.error('[taskService] addProject failed:', e);
    return null;
  }
}

/** Find a project by name or create it, so generated tasks can be grouped atomically. */
export async function ensureProject(name: string, color = ''): Promise<string | null> {
  const normalized = name.trim().toLocaleLowerCase();
  if (!normalized) return null;
  const projects = await dbGetProjects();
  const existing = projects.find(
    (project: any) => String(project.name).trim().toLocaleLowerCase() === normalized
  );
  if (existing) {
    useStore.getState().setProjects(projects as any);
    return existing.id;
  }
  const created = await addProject(name, color);
  return created?.id ?? null;
}

export async function renameProject(id: string, name: string, color?: string): Promise<void> {
  try {
    await dbUpdateProject(id, { name, color });
    await loadProjects();
  } catch (e) {
    console.error('[taskService] renameProject failed:', e);
  }
}

export async function removeProject(id: string): Promise<void> {
  try {
    await dbDeleteProject(id);
    await loadProjects();
    // Reflect the unassignment locally.
    const tasks = useStore.getState().currentTasks.map((t) =>
      t.project_id === id ? { ...t, project_id: null } : t
    );
    useStore.getState().setTasks(tasks);
  } catch (e) {
    console.error('[taskService] removeProject failed:', e);
  }
}

// ── Milestones ───────────────────────────────────────────

export async function loadMilestones(): Promise<void> {
  try {
    useStore.getState().setMilestones((await dbGetMilestones()) as any);
  } catch (e) {
    console.error('[taskService] loadMilestones failed:', e);
  }
}

export async function addMilestone(name: string, projectId: string | null = null, due = ''): Promise<void> {
  try {
    await dbCreateMilestone(name, projectId, due);
    await loadMilestones();
  } catch (e) {
    console.error('[taskService] addMilestone failed:', e);
  }
}

export async function renameMilestone(id: string, data: { name: string; due?: string; project_id?: string | null }): Promise<void> {
  try {
    await dbUpdateMilestone(id, data);
    await loadMilestones();
  } catch (e) {
    console.error('[taskService] renameMilestone failed:', e);
  }
}

export async function removeMilestone(id: string): Promise<void> {
  try {
    await dbDeleteMilestone(id);
    await loadMilestones();
    const tasks = useStore.getState().currentTasks.map((t) =>
      t.milestone_id === id ? { ...t, milestone_id: null } : t
    );
    useStore.getState().setTasks(tasks);
  } catch (e) {
    console.error('[taskService] removeMilestone failed:', e);
  }
}

/**
 * Reorder tasks: optimistic reorder → DB persist → rollback on failure.
 */
export async function reorderTasks(orderedIds: string[]): Promise<void> {
  const saved = snapshot();
  // Reconstruct the prior order from sort_order so undo restores it exactly.
  const prevIds = [...saved]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((t) => t.id);

  // Optimistic reorder
  useStore.getState().reorderTasks(orderedIds);

  try {
    await dbUpdateSortOrders(orderedIds);

    record({
      label: 'Reorder tasks',
      undo: async () => {
        await dbUpdateSortOrders(prevIds);
        useStore.getState().reorderTasks(prevIds);
      },
      redo: async () => {
        await dbUpdateSortOrders(orderedIds);
        useStore.getState().reorderTasks(orderedIds);
      },
    });
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

// ── Trash (soft-delete recovery surface) ─────────────────

/** Load the Trash (soft-deleted tasks) into the store for the Trash view. */
export async function loadTrash(): Promise<void> {
  try {
    const trash = await dbGetTrash();
    useStore.getState().setTasks(trash as Task[]);
  } catch (error) {
    console.error('[taskService] loadTrash failed:', error);
    useStore.getState().setAppError('Failed to load Trash.');
  }
}

/** Restore a single task out of the Trash. Removes it from the current Trash list. */
export async function restoreFromTrash(id: string): Promise<void> {
  const saved = snapshot();
  useStore.getState().removeTaskOptimistic(id);
  try {
    await dbRestoreTask(id);
  } catch (error) {
    rollback(saved, error, 'restore task');
  }
}

/** Permanently delete a single task from the Trash. Not reversible. */
export async function purgeTask(id: string): Promise<void> {
  const saved = snapshot();
  useStore.getState().removeTaskOptimistic(id);
  try {
    await dbDeleteTask(id);
  } catch (error) {
    rollback(saved, error, 'purge task');
  }
}

/** Permanently delete every task in the Trash. Not reversible. */
export async function emptyTrash(): Promise<number> {
  const saved = snapshot();
  useStore.getState().setTasks([]);
  try {
    const n = await dbEmptyTrash();
    return n;
  } catch (error) {
    rollback(saved, error, 'empty Trash');
    return 0;
  }
}

// ── Undo / redo (thin wrappers over services/history) ────

/** Undo the last recorded mutation. Returns its label, or null if nothing to undo. */
export async function undoLast(): Promise<string | null> {
  await Promise.all([...pendingMutations]);
  try {
    return await historyUndo();
  } catch {
    useStore.getState().setAppError('Could not undo the last action.');
    return null;
  }
}

/** Redo the last undone mutation. Returns its label, or null if nothing to redo. */
export async function redoLast(): Promise<string | null> {
  await Promise.all([...pendingMutations]);
  try {
    return await historyRedo();
  } catch {
    useStore.getState().setAppError('Could not redo.');
    return null;
  }
}
