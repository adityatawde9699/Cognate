import { create } from 'zustand';
import type { AiQuery } from './services/aiService';

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
  // Phase 3
  project_id: string | null;
  parent_id: string | null;
  recurrence: Recurrence;
  milestone_id: string | null;
  custom_fields: Record<string, string>;
  // Act 0: soft-delete. Null for live tasks; ISO timestamp when trashed.
  deleted_at?: string | null;
  // Act 1: scheduling attributes consumed by the planner.
  duration_min?: number;
  scheduled_start?: string | null; // ISO datetime assigned by the planner
  scheduled_end?: string | null;
  energy?: 'hi' | 'med' | 'lo';
  pinned?: boolean;
}

export type Energy = 'hi' | 'med' | 'lo';

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO datetime
  end: string;   // ISO datetime
  source: string;
  created_at: string;
}

export type Recurrence = 'none' | 'daily' | 'weekly' | 'monthly';

export interface Project {
  id: string;
  name: string;
  color: string;
  created_at: string;
  sort_order: number;
}

export interface Milestone {
  id: string;
  project_id: string | null;
  name: string;
  due: string;
  created_at: string;
  sort_order: number;
}

export type CustomFieldType = 'text' | 'number' | 'url' | 'date' | 'select';
export interface CustomFieldDef {
  id: string;
  name: string;
  type: CustomFieldType;
  options?: string[]; // for 'select'
}

export type CanvasView = 'board' | 'list' | 'table' | 'calendar' | 'timeline';

export type FilterType = 'all' | 'today' | 'high' | string;

interface AppState {
  // ── Application-level error ──────────────────────────
  appError: string | null;
  setAppError: (error: string | null) => void;

  // ── Undo / redo availability (driven by services/history) ──
  canUndo: boolean;
  canRedo: boolean;
  setHistoryState: (canUndo: boolean, canRedo: boolean) => void;

  // ── Core task state ─────────────────────────────────
  currentFilter: FilterType;
  currentTasks: Task[];
  searchQuery: string;
  aiQuery: AiQuery | null;
  aiQueryLabel: string;

  projects: Project[];
  setProjects: (projects: Project[]) => void;

  milestones: Milestone[];
  setMilestones: (milestones: Milestone[]) => void;

  customFieldDefs: CustomFieldDef[];
  setCustomFieldDefs: (defs: CustomFieldDef[]) => void;

  canvasView: CanvasView;
  setCanvasView: (view: CanvasView) => void;

  setFilter: (filter: FilterType) => void;
  setTasks: (tasks: Task[]) => void;
  setSearchQuery: (query: string) => void;
  setAiQuery: (query: AiQuery | null, label?: string) => void;

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

  isGenerateModalOpen: boolean;
  setGenerateModalOpen: (isOpen: boolean) => void;

  isCommandOpen: boolean;
  setCommandOpen: (isOpen: boolean) => void;

  isFocusMode: boolean;
  setFocusMode: (on: boolean) => void;

  templatesMode: 'save' | 'apply' | null;
  setTemplatesMode: (mode: 'save' | 'apply' | null) => void;
}

export const useStore = create<AppState>((set) => ({
  // ── Application-level error ──────────────────────────
  appError: null,
  setAppError: (error) => set({ appError: error }),

  canUndo: false,
  canRedo: false,
  setHistoryState: (canUndo, canRedo) => set({ canUndo, canRedo }),

  // ── Core task state ─────────────────────────────────
  // Act 1: the Plan ("your day, already laid out") is the landing view.
  currentFilter: 'plan',
  currentTasks: [],
  searchQuery: '',
  aiQuery: null,
  aiQueryLabel: '',

  projects: [],
  setProjects: (projects: Project[]) => set({ projects }),

  milestones: [],
  setMilestones: (milestones: Milestone[]) => set({ milestones }),

  customFieldDefs: [],
  setCustomFieldDefs: (defs: CustomFieldDef[]) => set({ customFieldDefs: defs }),

  canvasView: 'board',
  setCanvasView: (view: CanvasView) => set({ canvasView: view }),

  isTaskModalOpen: false,
  editingTask: null,
  setTaskModalOpen: (isOpen, task = null) => set({ isTaskModalOpen: isOpen, editingTask: task }),

  isSettingsModalOpen: false,
  setSettingsModalOpen: (isOpen) => set({ isSettingsModalOpen: isOpen }),

  isAnalyticsOpen: false,
  setAnalyticsOpen: (isOpen) => set({ isAnalyticsOpen: isOpen }),

  isGenerateModalOpen: false,
  setGenerateModalOpen: (isOpen) => set({ isGenerateModalOpen: isOpen }),

  isCommandOpen: false,
  setCommandOpen: (isOpen) => set({ isCommandOpen: isOpen }),

  isFocusMode: false,
  setFocusMode: (on) => set({ isFocusMode: on }),

  templatesMode: null,
  setTemplatesMode: (mode) => set({ templatesMode: mode }),

  // Changing the filter clears any active AI query.
  setFilter: (filter: FilterType) => set({ currentFilter: filter, aiQuery: null, aiQueryLabel: '' }),
  setTasks: (tasks: Task[]) => set({ currentTasks: tasks }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),
  setAiQuery: (query, label = '') => set({ aiQuery: query, aiQueryLabel: label }),

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
      currentTasks: state.currentTasks.map((t) => {
        if (t.id !== id) return t;
        const nowDone = !t.done;
        return {
          ...t,
          done: nowDone,
          completed_at: nowDone ? new Date().toISOString() : null,
        };
      }),
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
