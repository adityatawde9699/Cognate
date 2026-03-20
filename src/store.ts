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
  currentFilter: FilterType;
  currentTasks: Task[];
  searchQuery: string;
  
  setFilter: (filter: FilterType) => void;
  setTasks: (tasks: Task[]) => void;
  setSearchQuery: (query: string) => void;
  
  // Modals
  isTaskModalOpen: boolean;
  editingTask: Task | null;
  setTaskModalOpen: (isOpen: boolean, task?: Task | null) => void;

  isSettingsModalOpen: boolean;
  setSettingsModalOpen: (isOpen: boolean) => void;

  // Computed values that existed in previous format
  getVisibleTasks: () => Task[];
}

export const useStore = create<AppState>((set, get) => ({
  currentFilter: 'all',
  currentTasks: [],
  searchQuery: '',
  
  isTaskModalOpen: false,
  editingTask: null,
  setTaskModalOpen: (isOpen, task = null) => set({ isTaskModalOpen: isOpen, editingTask: task }),

  isSettingsModalOpen: false,
  setSettingsModalOpen: (isOpen) => set({ isSettingsModalOpen: isOpen }),
  
  setFilter: (filter: FilterType) => set({ currentFilter: filter }),
  setTasks: (tasks: Task[]) => set({ currentTasks: tasks }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),
  
  getVisibleTasks: () => {
    const { currentTasks, searchQuery } = get();
    if (!searchQuery) return currentTasks;
    
    const q = searchQuery.toLowerCase();
    return currentTasks.filter((t: Task) => 
      t.title.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.tags.some((tag: string) => tag.toLowerCase().includes(q))
    );
  }
}));
