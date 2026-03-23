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

  isAnalyticsOpen: boolean;
  setAnalyticsOpen: (isOpen: boolean) => void;

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
  
  isAnalyticsOpen: false,
  setAnalyticsOpen: (isOpen) => set({ isAnalyticsOpen: isOpen }),

  setFilter: (filter: FilterType) => set({ currentFilter: filter }),
  setTasks: (tasks: Task[]) => set({ currentTasks: tasks }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),
  
  getVisibleTasks: () => {
    const { currentTasks, currentFilter, searchQuery } = get();
    let tasks = currentTasks;
    
    // Apply filter
    const d = new Date();
    const todayStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    if (currentFilter === 'today') {
      tasks = tasks.filter((t: Task) => t.deadline === todayStr);
    } else if (currentFilter === 'high') {
      tasks = tasks.filter((t: Task) => t.priority === 'high' && !t.done);
    } else if (currentFilter.startsWith('tag:')) {
      const tag = currentFilter.substring(4);
      tasks = tasks.filter((t: Task) => t.tags && t.tags.includes(tag));
    }

    if (!searchQuery) return tasks;
    
    const q = searchQuery.toLowerCase();
    return tasks.filter((t: Task) => 
      t.title.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      (t.tags && t.tags.some((tag: string) => tag.toLowerCase().includes(q)))
    );
  }
}));
