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
      currentFilter: 'all',
      appError: null,
    });
  });

  it('should set tasks correctly', () => {
    useStore.getState().setTasks(mockTasks);
    expect(useStore.getState().currentTasks.length).toBe(2);
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

  // ── appError state (Track 1) ──────────────────────
  it('should manage appError state', () => {
    expect(useStore.getState().appError).toBeNull();

    useStore.getState().setAppError('Something went wrong');
    expect(useStore.getState().appError).toBe('Something went wrong');

    useStore.getState().setAppError(null);
    expect(useStore.getState().appError).toBeNull();
  });

  // ── CQRS mutation actions (Track 3) ────────────────
  it('should add task optimistically', () => {
    useStore.getState().setTasks(mockTasks);
    const newTask: Task = {
      id: '3', title: 'Task 3', description: '', tags: [], deadline: '',
      importance: 2, effort: 2, done: false, created_at: '', completed_at: null,
      pomodoros_spent: 0, priority: 'medium', sort_order: 3
    };
    useStore.getState().addTaskOptimistic(newTask);
    expect(useStore.getState().currentTasks.length).toBe(3);
    expect(useStore.getState().currentTasks[2].title).toBe('Task 3');
  });

  it('should update task optimistically', () => {
    useStore.getState().setTasks(mockTasks);
    useStore.getState().updateTaskOptimistic('1', { title: 'Updated Task 1' });
    expect(useStore.getState().currentTasks[0].title).toBe('Updated Task 1');
    // Other fields remain unchanged
    expect(useStore.getState().currentTasks[0].priority).toBe('high');
  });

  it('should remove task optimistically', () => {
    useStore.getState().setTasks(mockTasks);
    useStore.getState().removeTaskOptimistic('1');
    expect(useStore.getState().currentTasks.length).toBe(1);
    expect(useStore.getState().currentTasks[0].id).toBe('2');
  });

  it('should toggle task optimistically', () => {
    useStore.getState().setTasks(mockTasks);
    // Task 1 is not done → should become done
    useStore.getState().toggleTaskOptimistic('1');
    const toggled = useStore.getState().currentTasks.find(t => t.id === '1')!;
    expect(toggled.done).toBe(true);
    expect(toggled.completed_at).toBeTruthy();

    // Toggle back
    useStore.getState().toggleTaskOptimistic('1');
    const toggledBack = useStore.getState().currentTasks.find(t => t.id === '1')!;
    expect(toggledBack.done).toBe(false);
    expect(toggledBack.completed_at).toBeNull();
  });

  it('should increment pomodoro count', () => {
    useStore.getState().setTasks(mockTasks);
    useStore.getState().incrementPomodoro('1');
    expect(useStore.getState().currentTasks[0].pomodoros_spent).toBe(1);
    useStore.getState().incrementPomodoro('1');
    expect(useStore.getState().currentTasks[0].pomodoros_spent).toBe(2);
  });

  it('should reorder tasks by id', () => {
    useStore.getState().setTasks(mockTasks);
    // Reverse the order: ['2', '1']
    useStore.getState().reorderTasks(['2', '1']);
    const task1 = useStore.getState().currentTasks.find(t => t.id === '1')!;
    const task2 = useStore.getState().currentTasks.find(t => t.id === '2')!;
    expect(task2.sort_order).toBe(0);
    expect(task1.sort_order).toBe(1);
  });
});
