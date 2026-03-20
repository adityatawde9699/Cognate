import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { calcPriority, createTask, updateTask } from '../../db';
import { toast } from '../../utils/toast';

const P_LABEL: Record<number, string> = { 1: 'Low', 2: 'Medium', 3: 'High' };
const P_COLOR: Record<number, string> = { 1: 'var(--success)', 2: 'var(--warning)', 3: 'var(--danger)' };

export function TaskModal() {
  const { isTaskModalOpen, editingTask, setTaskModalOpen } = useStore();
  
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [tags, setTags] = useState('');
  const [importance, setImportance] = useState(3);
  const [effort, setEffort] = useState(3);
  const [priorityPreview, setPriorityPreview] = useState(2); // default Medium

  useEffect(() => {
    if (isTaskModalOpen) {
      if (editingTask) {
        setTitle(editingTask.title);
        setDescription(editingTask.description || '');
        setDeadline(editingTask.deadline || '');
        setTags((editingTask.tags || []).join(', '));
        setImportance(editingTask.importance);
        setEffort(editingTask.effort);
      } else {
        setTitle('');
        setDescription('');
        setDeadline('');
        setTags('');
        setImportance(3);
        setEffort(3);
      }
    }
  }, [isTaskModalOpen, editingTask]);

  useEffect(() => {
    async function updatePreview() {
      if (isTaskModalOpen) {
        const p = await calcPriority(importance, effort, deadline);
        setPriorityPreview(p);
      }
    }
    updatePreview();
  }, [importance, effort, deadline, isTaskModalOpen]);

  if (!isTaskModalOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      toast('⚠️ Please enter a task title');
      return;
    }

    const payload = {
      title: title.trim(),
      description: description.trim(),
      deadline,
      tags: tags.split(',').map(t => t.trim()).filter(Boolean),
      importance,
      effort,
    };

    if (editingTask) {
      await updateTask(editingTask.id, payload);
      toast('✏️ Task updated');
    } else {
      await createTask(payload);
      toast('✅ Task created!');
    }

    setTaskModalOpen(false);
    // TODO: Need to refresh tasks list from DB here maybe trigger a global refresh?
    // This will be handled in board/store implementation.
    window.dispatchEvent(new CustomEvent('refresh-tasks'));
  };

  return (
    <div className={`modal-overlay ${isTaskModalOpen ? 'open' : ''}`} onClick={(e) => {
      if ((e.target as HTMLElement).className.includes('modal-overlay')) {
        setTaskModalOpen(false);
      }
    }}>
      <div className="modal">
        <div className="modal-header">
          <h2>{editingTask ? 'Edit Task' : 'New Task'}</h2>
          <button className="btn-icon" onClick={() => setTaskModalOpen(false)}>
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="modal-body">
            
          <div className="form-group">
            <label>Title</label>
            <input 
              type="text" 
              value={title} 
              onChange={e => setTitle(e.target.value)} 
              placeholder="What needs to be done?" 
              autoFocus 
            />
          </div>

          <div className="form-group">
            <label>Description</label>
            <textarea 
              rows={3} 
              value={description} 
              onChange={e => setDescription(e.target.value)} 
              placeholder="Add details..."
            ></textarea>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Deadline</label>
              <input 
                type="date" 
                value={deadline} 
                onChange={e => setDeadline(e.target.value)} 
              />
            </div>
            <div className="form-group">
              <label>Tags (comma separated)</label>
              <input 
                type="text" 
                value={tags} 
                onChange={e => setTags(e.target.value)} 
                placeholder="work, urgent" 
              />
            </div>
          </div>

          <div className="slider-group">
            <label>
              Importance <span className="val-preview">{importance}</span>
            </label>
            <input 
              type="range" 
              min="1" max="5" 
              value={importance}
              onChange={e => setImportance(parseInt(e.target.value))} 
            />
          </div>

          <div className="slider-group">
            <label>
              Effort <span className="val-preview">{effort}</span>
            </label>
            <input 
              type="range" 
              min="1" max="5" 
              value={effort}
              onChange={e => setEffort(parseInt(e.target.value))} 
            />
          </div>

          <div className="prio-preview">
            Calculated Priority: <strong style={{ color: P_COLOR[priorityPreview] || 'inherit' }}>
              {P_LABEL[priorityPreview] || priorityPreview}
            </strong>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn-ghost" onClick={() => setTaskModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn-primary">Save Task</button>
          </div>
        </form>
      </div>
    </div>
  );
}
