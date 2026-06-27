import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { calcPriority } from '../../db';
import { addTask, editTask } from '../../services/taskService';
import { toast } from '../../utils/toast';
import { improveDescription, breakIntoSubtasks, suggestPriority, suggestTags } from '../../services/aiService';
import { TaskComments } from '../TaskComments';

const P_LABEL: Record<string, string> = { 'low': 'Low', 'medium': 'Medium', 'high': 'High' };
const P_COLOR: Record<string, string> = { 'low': 'var(--success)', 'medium': 'var(--warning)', 'high': 'var(--danger)' };

export function TaskModal() {
  const { isTaskModalOpen, editingTask, setTaskModalOpen } = useStore();
  const projects = useStore((s) => s.projects);
  const milestones = useStore((s) => s.milestones);
  const customFieldDefs = useStore((s) => s.customFieldDefs);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [tags, setTags] = useState('');
  const [importance, setImportance] = useState(3);
  const [effort, setEffort] = useState(3);
  const [projectId, setProjectId] = useState<string>('');
  const [milestoneId, setMilestoneId] = useState<string>('');
  const [recurrence, setRecurrence] = useState<'none' | 'daily' | 'weekly' | 'monthly'>('none');
  const [customFields, setCustomFields] = useState<Record<string, string>>({});
  const [priorityPreview, setPriorityPreview] = useState<string>('medium'); // default Medium
  const [aiBusy, setAiBusy] = useState<null | 'improve' | 'subtasks' | 'priority' | 'tags'>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isTaskModalOpen);

  useEffect(() => {
    if (isTaskModalOpen) {
      if (editingTask) {
        setTitle(editingTask.title);
        setDescription(editingTask.description || '');
        setDeadline(editingTask.deadline || '');
        setTags((editingTask.tags || []).join(', '));
        setImportance(editingTask.importance);
        setEffort(editingTask.effort);
        setProjectId(editingTask.project_id || '');
        setMilestoneId(editingTask.milestone_id || '');
        setRecurrence(editingTask.recurrence || 'none');
        setCustomFields(editingTask.custom_fields || {});
      } else {
        setTitle('');
        setDescription('');
        setDeadline('');
        setTags('');
        setImportance(3);
        setEffort(3);
        setProjectId('');
        setMilestoneId('');
        setRecurrence('none');
        setCustomFields({});
      }
    }
  }, [isTaskModalOpen, editingTask]);

  useEffect(() => {
    async function updatePreview() {
      if (isTaskModalOpen) {
        const p = await calcPriority(importance, effort, deadline);
        setPriorityPreview(p || 'medium');
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
      project_id: projectId || null,
      parent_id: editingTask?.parent_id ?? null,
      recurrence,
      milestone_id: milestoneId || null,
      custom_fields: customFields,
    };

    if (editingTask) {
      await editTask(editingTask.id, payload);
      toast('✏️ Task updated');
    } else {
      await addTask(payload);
      toast('✅ Task created!');
    }

    setTaskModalOpen(false);
    // No more window.dispatchEvent('refresh-tasks') — CQRS handles state updates
  };

  const aiTask = () => ({
    title: title.trim(),
    description: description.trim(),
    tags: tags.split(',').map(t => t.trim()).filter(Boolean),
    deadline,
    importance,
    effort,
  });

  const handleImprove = async () => {
    if (!title.trim()) { toast('⚠️ Add a title first'); return; }
    setAiBusy('improve');
    try {
      const text = await improveDescription(aiTask());
      setDescription(text);
      toast('✨ Description improved');
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setAiBusy(null);
    }
  };

  const handleSubtasks = async () => {
    if (!title.trim()) { toast('⚠️ Add a title first'); return; }
    setAiBusy('subtasks');
    try {
      const list = await breakIntoSubtasks(aiTask());
      setDescription(d => (d.trim() ? `${d.trim()}\n\n${list}` : list));
      toast('✨ Subtasks added');
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setAiBusy(null);
    }
  };

  const handleSuggestTags = async () => {
    if (!title.trim()) { toast('⚠️ Add a title first'); return; }
    setAiBusy('tags');
    try {
      const suggested = await suggestTags(aiTask());
      const existing = tags.split(',').map(t => t.trim()).filter(Boolean);
      const merged = Array.from(new Set([...existing, ...suggested]));
      setTags(merged.join(', '));
      toast('✨ Tags suggested');
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setAiBusy(null);
    }
  };

  const handleSuggestPriority = async () => {
    if (!title.trim()) { toast('⚠️ Add a title first'); return; }
    setAiBusy('priority');
    try {
      const suggestion = await suggestPriority(aiTask());
      toast(`✨ ${suggestion}`);
    } catch (e: any) {
      toast(`⚠️ ${e.message || String(e)}`);
    } finally {
      setAiBusy(null);
    }
  };

  return (
    <div className={`editor-overlay ${isTaskModalOpen ? 'open' : ''}`} onClick={(e) => {
      if ((e.target as HTMLElement).className.includes('editor-overlay')) {
        setTaskModalOpen(false);
      }
    }}>
      <div ref={panelRef} className="editor-panel" role="dialog" aria-modal="true" aria-label={editingTask ? 'Edit task' : 'New task'} style={{ display: 'flex', flexDirection: 'column', width: '480px', height: '100%', background: '#131316', overflowY: 'hidden' }}>
        <div className="editor-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,.1)', flexShrink: 0 }}>
          <div className="editor-head-l">
            <span className="editor-kicker" style={{ color: '#a1a1aa', fontSize: '.82rem' }}>{editingTask ? 'Edit task' : 'New task'}</span>
            <span className={`editor-prio-pill ${priorityPreview || 'medium'}`}>
              <span className="p-dot"></span>
              {P_LABEL[priorityPreview] || priorityPreview}
            </span>
          </div>
          <button className="btn-icon" onClick={() => setTaskModalOpen(false)} aria-label="Close">
            <i className="fa-solid fa-xmark"></i>
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ flex: '1 1 auto', overflowY: 'auto', padding: '22px', display: 'block' }}>
          <div style={{ marginBottom: '16px' }}>
            <input
              className="editor-title"
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="What needs doing?"
              autoFocus
              style={{ display: 'block', width: '100%', minHeight: '44px', fontSize: '1.15rem', fontWeight: 700, color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', padding: '12px 14px', boxSizing: 'border-box', outline: 'none', WebkitAppearance: 'none', appearance: 'none' as any }}
            />
          </div>

          <div style={{ marginBottom: '16px' }}>
            <span style={{ display: 'block', color: '#a1a1aa', fontSize: '.82rem', marginBottom: '6px' }}>Description</span>
            <textarea
              className="editor-desc"
              rows={4}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Add details, context, or a checklist…"
              style={{ display: 'block', width: '100%', minHeight: '88px', fontSize: '.9rem', color: '#a1a1aa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', padding: '12px 14px', boxSizing: 'border-box', outline: 'none', resize: 'vertical', WebkitAppearance: 'none', appearance: 'none' as any }}
            ></textarea>
          </div>

          <div className="ai-actions" style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            <button type="button" className="btn-ai" disabled={!!aiBusy} onClick={handleImprove} style={{ padding: '8px 14px', borderRadius: '9px', fontSize: '.85rem' }}>
              <i className={`fa-solid ${aiBusy === 'improve' ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
              {' '}Improve
            </button>
            <button type="button" className="btn-ai" disabled={!!aiBusy} onClick={handleSubtasks} style={{ padding: '8px 14px', borderRadius: '9px', fontSize: '.85rem' }}>
              <i className={`fa-solid ${aiBusy === 'subtasks' ? 'fa-spinner fa-spin' : 'fa-list-check'}`}></i>
              {' '}Break into subtasks
            </button>
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,.08)', paddingTop: '12px' }}>
            <div style={{ fontSize: '.68rem', letterSpacing: '.12em', textTransform: 'uppercase' as const, color: '#71717a', fontWeight: 600, padding: '4px 0 8px' }}>Properties</div>

            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: '12px', padding: '7px 0' }}>
              <label style={{ color: '#a1a1aa', fontSize: '.83rem' }}><i className="fa-solid fa-calendar-day" style={{ marginRight: '8px', color: '#71717a' }}></i>Deadline</label>
              <input
                type="date"
                value={deadline}
                onChange={e => setDeadline(e.target.value)}
                style={{ padding: '9px 12px', fontSize: '.87rem', color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', outline: 'none', width: '100%', boxSizing: 'border-box', WebkitAppearance: 'none', appearance: 'none' as any }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: '12px', padding: '7px 0' }}>
              <label style={{ color: '#a1a1aa', fontSize: '.83rem' }}><i className="fa-solid fa-hashtag" style={{ marginRight: '8px', color: '#71717a' }}></i>Tags</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text"
                  value={tags}
                  onChange={e => setTags(e.target.value)}
                  placeholder="work, marketing"
                  style={{ flex: 1, padding: '9px 12px', fontSize: '.87rem', color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', outline: 'none', boxSizing: 'border-box', WebkitAppearance: 'none', appearance: 'none' as any }}
                />
                <button type="button" className="btn-ai btn-ai-inline" disabled={!!aiBusy} onClick={handleSuggestTags} style={{ padding: '6px 10px', borderRadius: '8px', fontSize: '.8rem', flexShrink: 0 }}>
                  <i className={`fa-solid ${aiBusy === 'tags' ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
                  {' '}Suggest
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: '12px', padding: '7px 0' }}>
              <label style={{ color: '#a1a1aa', fontSize: '.83rem' }}><i className="fa-solid fa-folder" style={{ marginRight: '8px', color: '#71717a' }}></i>Project</label>
              <select value={projectId} onChange={e => setProjectId(e.target.value)} style={{ padding: '9px 12px', fontSize: '.87rem', color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', outline: 'none', width: '100%', boxSizing: 'border-box', WebkitAppearance: 'none', appearance: 'none' as any }}>
                <option value="">No project</option>
                {(projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: '12px', padding: '7px 0' }}>
              <label style={{ color: '#a1a1aa', fontSize: '.83rem' }}><i className="fa-solid fa-flag-checkered" style={{ marginRight: '8px', color: '#71717a' }}></i>Milestone</label>
              <select value={milestoneId} onChange={e => setMilestoneId(e.target.value)} style={{ padding: '9px 12px', fontSize: '.87rem', color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', outline: 'none', width: '100%', boxSizing: 'border-box', WebkitAppearance: 'none', appearance: 'none' as any }}>
                <option value="">No milestone</option>
                {milestones
                  .filter(m => !m.project_id || !projectId || m.project_id === projectId)
                  .map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: '12px', padding: '7px 0' }}>
              <label style={{ color: '#a1a1aa', fontSize: '.83rem' }}><i className="fa-solid fa-repeat" style={{ marginRight: '8px', color: '#71717a' }}></i>Repeat</label>
              <select value={recurrence} onChange={e => setRecurrence(e.target.value as any)} style={{ padding: '9px 12px', fontSize: '.87rem', color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', outline: 'none', width: '100%', boxSizing: 'border-box', WebkitAppearance: 'none', appearance: 'none' as any }}>
                <option value="none">Does not repeat</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </div>

            {customFieldDefs.map(f => (
              <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: '12px', padding: '7px 0' }} key={f.id}>
                <label style={{ color: '#a1a1aa', fontSize: '.83rem' }}><i className="fa-solid fa-sliders" style={{ marginRight: '8px', color: '#71717a' }}></i>{f.name}</label>
                {f.type === 'select' ? (
                  <select
                    value={customFields[f.id] || ''}
                    onChange={e => setCustomFields(c => ({ ...c, [f.id]: e.target.value }))}
                    style={{ padding: '9px 12px', fontSize: '.87rem', color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', outline: 'none', width: '100%', boxSizing: 'border-box', WebkitAppearance: 'none', appearance: 'none' as any }}
                  >
                    <option value="">—</option>
                    {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text'}
                    value={customFields[f.id] || ''}
                    onChange={e => setCustomFields(c => ({ ...c, [f.id]: e.target.value }))}
                    style={{ padding: '9px 12px', fontSize: '.87rem', color: '#fafafa', background: '#202027', border: '1px solid rgba(255,255,255,.18)', borderRadius: '9px', outline: 'none', width: '100%', boxSizing: 'border-box', WebkitAppearance: 'none', appearance: 'none' as any }}
                  />
                )}
              </div>
            ))}

            <div style={{ padding: '7px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#a1a1aa', fontSize: '.83rem', marginBottom: '8px' }}>
                <i className="fa-solid fa-star" style={{ color: '#71717a' }}></i>
                Importance <span style={{ color: '#34d399', fontFamily: 'monospace', fontSize: '.78rem', marginLeft: '6px' }}>{importance}</span>
              </label>
              <input
                type="range"
                min="1" max="5"
                value={importance}
                onChange={e => setImportance(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: '#34d399' }}
              />
            </div>

            <div style={{ padding: '7px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#a1a1aa', fontSize: '.83rem', marginBottom: '8px' }}>
                <i className="fa-solid fa-gauge-high" style={{ color: '#71717a' }}></i>
                Effort <span style={{ color: '#34d399', fontFamily: 'monospace', fontSize: '.78rem', marginLeft: '6px' }}>{effort}</span>
              </label>
              <input
                type="range"
                min="1" max="5"
                value={effort}
                onChange={e => setEffort(parseInt(e.target.value))}
                style={{ width: '100%', accentColor: '#34d399' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', alignItems: 'center', gap: '12px', padding: '7px 0' }}>
              <label style={{ color: '#a1a1aa', fontSize: '.83rem' }}><i className="fa-solid fa-signal" style={{ marginRight: '8px', color: '#71717a' }}></i>Priority</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <strong style={{ color: P_COLOR[priorityPreview] || 'inherit', fontSize: '.9rem', textTransform: 'capitalize' as const }}>
                  {P_LABEL[priorityPreview] || priorityPreview}
                </strong>
                <span style={{ fontSize: '.7rem', color: '#71717a' }}>computed</span>
                <button type="button" className="btn-ai btn-ai-inline" disabled={!!aiBusy} onClick={handleSuggestPriority} style={{ marginLeft: 'auto', padding: '6px 10px', borderRadius: '8px', fontSize: '.8rem' }}>
                  <i className={`fa-solid ${aiBusy === 'priority' ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
                  {' '}Suggest
                </button>
              </div>
            </div>
          </div>

          {editingTask && (
            <TaskComments taskId={editingTask.id} projectId={editingTask.project_id} />
          )}

          {editingTask && (
            <p style={{ fontSize: '.74rem', color: '#71717a', paddingTop: '4px' }}>
              Created {new Date(editingTask.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              {editingTask.pomodoros_spent > 0 && ` · ${editingTask.pomodoros_spent} pomodoros`}
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px', paddingTop: '8px' }}>
            <button type="button" className="btn-ghost" onClick={() => setTaskModalOpen(false)} style={{ padding: '10px 18px', borderRadius: '9px', fontSize: '.87rem' }}>Cancel</button>
            <button type="submit" className="btn-primary" style={{ padding: '10px 18px', borderRadius: '9px', fontSize: '.87rem' }}>{editingTask ? 'Save changes' : 'Create task'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

