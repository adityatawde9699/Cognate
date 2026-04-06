import { create } from 'zustand';

// Types roughly corresponding to the old `state.js` structure
export interface Task {
  id: string;
  title: string;
  description: string;
  tags: string[];
  deadline: string;
  importance: number;
  effort: number;
  done: boolean;
  created_at: string;
  completed_at: string | null;
  pomodoros_spent: number;
  priority: 'low' | 'medium' | 'high';
  sort_order: number;
}

export type FilterType = 'all' | 'today' | 'high' | string;

interface AppState {
  // ── Application-level error ──────────────────────────
  appError: string | null;
  setAppError: (error: string | null) => void;

  // ── Core task state ─────────────────────────────────
  currentFilter: FilterType;
  currentTasks: Task[];
  searchQuery: string;

  setFilter: (filter: FilterType) => void;
  setTasks: (tasks: Task[]) => void;
  setSearchQuery: (query: string) => void;

  // ── Fine-grained CQRS mutations (optimistic UI) ─────
  addTaskOptimistic: (task: Task) => void;
  updateTaskOptimistic: (id: string, partial: Partial<Task>) => void;
  removeTaskOptimistic: (id: string) => void;
  toggleTaskOptimistic: (id: string) => void;
  incrementPomodoro: (id: string) => void;
  reorderTasks: (orderedIds: string[]) => void;

  // ── Modals ──────────────────────────────────────────
  isTaskModalOpen: boolean;
  editingTask: Task | null;
  setTaskModalOpen: (isOpen: boolean, task?: Task | null) => void;

  isSettingsModalOpen: boolean;
  setSettingsModalOpen: (isOpen: boolean) => void;

  isAnalyticsOpen: boolean;
  setAnalyticsOpen: (isOpen: boolean) => void;
}

export const useStore = create<AppState>((set) => ({
  // ── Application-level error ──────────────────────────
  appError: null,
  setAppError: (error) => set({ appError: error }),

  // ── Core task state ─────────────────────────────────
  currentFilter: 'all',
  currentTasks: [],
  searchQuery: '',

  isTaskModalOpen: false,
  editingTask: null,
  setTaskModalOpen: (isOpen, task = null) => set({ isTaskModalOpen: isOpen, editingTask: task }),

  isSettingsModalOpen: false,
  setSettingsModalOpen: (isOpen) => set({ isSettingsModalOpen: isOpen }),

  isAnalyticsOpen: false,
  setAnalyticsOpen: (isOpen) => set({ isAnalyticsOpen: isOpen }),

  setFilter: (filter: FilterType) => set({ currentFilter: filter }),
  setTasks: (tasks: Task[]) => set({ currentTasks: tasks }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),

  // ── Fine-grained CQRS mutations ─────────────────────
  addTaskOptimistic: (task) =>
    set((state) => ({ currentTasks: [...state.currentTasks, task] })),

  updateTaskOptimistic: (id, partial) =>
    set((state) => ({
      currentTasks: state.currentTasks.map((t) =>
        t.id === id ? { ...t, ...partial } : t
      ),
    })),

  removeTaskOptimistic: (id) =>
    set((state) => ({
      currentTasks: state.currentTasks.filter((t) => t.id !== id),
    })),

  toggleTaskOptimistic: (id) =>
    set((state) => ({
      currentTasks: state.currentTasks.map((t) =>
        t.id === id
          ? { ...t, done: !t.done, completed_at: !t.done ? new Date().toISOString() : null }
          : t
      ),
    })),

  incrementPomodoro: (id) =>
    set((state) => ({
      currentTasks: state.currentTasks.map((t) =>
        t.id === id ? { ...t, pomodoros_spent: t.pomodoros_spent + 1 } : t
      ),
    })),

  reorderTasks: (orderedIds) =>
    set((state) => ({
      currentTasks: state.currentTasks.map((t) => {
        const idx = orderedIds.indexOf(t.id);
        return idx >= 0 ? { ...t, sort_order: idx } : t;
      }),
    })),
}));
