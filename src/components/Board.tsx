import { useStore, Task } from '../store';
import { useVisibleTasks } from '../hooks/useVisibleTasks';
import { TaskCard } from './TaskCard';
import { useState } from 'react';
import { toggleTaskDone, removeTask, reorderTasks } from '../services/taskService';

export function Board() {
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);
  const visibleTasks = useVisibleTasks();
  
  const pending = visibleTasks.filter((t: Task) => !t.done);
  const done    = visibleTasks.filter((t: Task) => t.done);

  // drag state – only IDs needed, no raw Task reference
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // ── DnD handlers ───────────────────────────────────
  const handleDragStart = (id: string) => setDraggedId(id);
  const handleDragOver  = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  };
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!draggedId || draggedId === dragOverId) {
      setDraggedId(null); setDragOverId(null); return;
    }
    // Reorder pending tasks list
    const pendingIds = pending.map(t => t.id);
    const fromIdx = pendingIds.indexOf(draggedId);
    const toIdx   = dragOverId ? pendingIds.indexOf(dragOverId) : pendingIds.length - 1;
    if (fromIdx !== -1 && toIdx !== -1) {
      pendingIds.splice(fromIdx, 1);
      pendingIds.splice(toIdx, 0, draggedId);
      await reorderTasks(pendingIds);
    }
    setDraggedId(null); setDragOverId(null);
  };

  // ── Task actions (CQRS — optimistic) ───────────────
  const handleToggle = async (task: Task) => {
    await toggleTaskDone(task.id);
  };

  const handleDelete = async (task: Task) => {
    await removeTask(task.id);
  };

  const handleEdit = (task: Task) => setTaskModalOpen(true, task);
  const handleSelectPomo = (task: Task) => {
    useStore.setState({ pomoTaskId: task.id } as any);
  };

  // ── Render helpers ─────────────────────────────────
  const renderList = (tasks: Task[], droppable = false) => {
    if (tasks.length === 0) {
      return (
        <div className="empty-state">
          <div className="empty-emoji">{droppable ? '🌱' : '📋'}</div>
          <p>{droppable ? "No pending tasks. You're on fire! 🔥" : 'Complete a task to see it here.'}</p>
        </div>
      );
    }
    return tasks.map((task: Task) => (
      <div
        key={task.id}
        className={`card-drop-zone ${dragOverId === task.id ? 'drag-over' : ''}`}
        onDragOver={(e) => droppable && handleDragOver(e, task.id)}
      >
        <TaskCard
          task={task}
          onEdit={handleEdit}
          onSelectPomo={handleSelectPomo}
          onToggle={handleToggle}
          onDelete={handleDelete}
          onDragStart={() => handleDragStart(task.id)}
        />
      </div>
    ));
  };

  return (
    <div className="board" onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      <section className="col">
        <div className="col-hd">
          <i className="fa-solid fa-hourglass-half"></i>
          Pending
          <span className="col-count">{pending.length}</span>
          <button className="btn-add-inline" onClick={() => setTaskModalOpen(true)} title="New Task">
            <i className="fa-solid fa-plus"></i>
          </button>
        </div>
        <div className="task-list" id="pendingList">
          {renderList(pending, true)}
        </div>
      </section>

      <section className="col">
        <div className="col-hd done-hd">
          <i className="fa-solid fa-circle-check"></i>
          Completed
          <span className="col-count">{done.length}</span>
        </div>
        <div className="task-list" id="doneList">
          {renderList(done, false)}
        </div>
      </section>
    </div>
  );
}
