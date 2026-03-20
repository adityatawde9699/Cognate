// import { useStore } from '../store';
import { Task } from '../store';
// @ts-ignore
import { P_LABEL, fmtDate, isOverdue } from '../utils/format';
import { useState } from 'react';

interface Props {
  task: Task;
  onEdit: (task: Task) => void;
  pomoTaskId?: string | null;
  onSelectPomo: (task: Task) => void;
  onToggle: (task: Task) => void;
  onDelete: (task: Task) => void;
  onDragStart?: () => void;
}

export function TaskCard({ task, onEdit, pomoTaskId, onSelectPomo, onToggle, onDelete, onDragStart }: Props) {
  const [isHovered, setIsHovered] = useState(false);
  const isPomoSel = pomoTaskId === task.id && !task.done;
  const isOverdueTask = isOverdue(task.deadline) && !task.done;

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(task);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(task);
  };

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('taskId', task.id);
    if (onDragStart) onDragStart();
  };

  return (
    <div 
      className={`task-card ${task.done ? 'done-card' : ''}`}
      data-id={task.id}
      draggable={!task.done}
      onDragStart={handleDragStart}
      tabIndex={0}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div className="card-top">
        <div 
          className={`card-check ${task.done ? 'checked' : ''}`} 
          onClick={handleToggle}
        >
          <i className="fa-solid fa-check"></i>
        </div>
        <span className="card-title">{task.title}</span>
        
        <div className="card-actions" style={{ opacity: isHovered || isPomoSel ? 1 : 0 }}>
          <button 
            className={`icon-btn btn-focus-sel ${isPomoSel ? 'active' : ''}`} 
            onClick={() => onSelectPomo(task)}
            title="Focus (Pomodoro)"
          >
            <i className="fa-solid fa-stopwatch"></i>
          </button>
          <button 
            className="icon-btn btn-edit" 
            onClick={() => onEdit(task)}
            title="Edit"
          >
            <i className="fa-solid fa-pen-to-square"></i>
          </button>
          <button 
            className="icon-btn del btn-del" 
            onClick={handleDelete}
            title="Delete"
          >
            <i className="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </div>

      {task.description && (
        <p className="card-desc">{task.description}</p>
      )}

      <div className="card-footer">
        <span className={`p-badge ${task.priority}`}>
          {P_LABEL[task.priority] || task.priority}
        </span>
        
        {task.tags?.map(t => t.trim()).filter(Boolean).map(t => (
          <span key={t} className="tag">{t}</span>
        ))}
        
        {task.deadline && (
          <span className={`deadline-lbl ${isOverdueTask ? 'overdue' : ''}`}>
            <i className="fa-regular fa-calendar"></i> {fmtDate(task.deadline)}
          </span>
        )}
        
        {task.pomodoros_spent > 0 && (
          <div className="pomo-dots">
            {Array.from({ length: Math.min(task.pomodoros_spent, 8) }).map((_, i) => (
              <div key={i} className="pomo-dot"></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
