import { describe, it, expect, beforeEach } from 'vitest';
import { useStore, Task } from './store';

describe('useStore Zustand Tests', () => {
  const mockTasks: Task[] = [
    {
      id: '1', title: 'Task 1', description: '', tags: ['work'], deadline: '',
      importance: 3, effort: 3, done: false, created_at: '', completed_at: null,
      pomodoros_spent: 0, priority: 'high', sort_order: 1
    },
    {
      id: '2', title: 'Task 2', description: 'Sample', tags: ['home'], deadline: '',
      importance: 1, effort: 1, done: true, created_at: '', completed_at: null,
      pomodoros_spent: 0, priority: 'low', sort_order: 2
    }
  ];

  beforeEach(() => {
    // Reset store
    useStore.setState({
      currentTasks: [],
      searchQuery: '',
      currentFilter: 'all'
    });
  });

  it('should set tasks correctly', () => {
    useStore.getState().setTasks(mockTasks);
    expect(useStore.getState().currentTasks.length).toBe(2);
  });

  it('should filter tasks by search query matching title', () => {
    useStore.getState().setTasks(mockTasks);
    useStore.getState().setSearchQuery('Task 1');
    const filtered = useStore.getState().getVisibleTasks();
    expect(filtered.length).toBe(1);
    expect(filtered[0].title).toBe('Task 1');
  });

  it('should filter tasks by search query matching tags', () => {
    useStore.getState().setTasks(mockTasks);
    useStore.getState().setSearchQuery('home');
    const filtered = useStore.getState().getVisibleTasks();
    expect(filtered.length).toBe(1);
    expect(filtered[0].title).toBe('Task 2');
  });

  it('should default modals to closed state', () => {
    expect(useStore.getState().isTaskModalOpen).toBe(false);
    expect(useStore.getState().isSettingsModalOpen).toBe(false);
  });

  it('should open task modal with task context', () => {
    useStore.getState().setTaskModalOpen(true, mockTasks[0]);
    expect(useStore.getState().isTaskModalOpen).toBe(true);
    expect(useStore.getState().editingTask).toEqual(mockTasks[0]);
  });
});
