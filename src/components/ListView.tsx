import { useStore, Task } from '../store';
import { useVisibleTasks } from '../hooks/useVisibleTasks';
import { toggleTaskDone, removeTask, addSubtask } from '../services/taskService';
import { fmtDate, isOverdue } from '../utils/format';

export function ListView() {
  const tasks = useVisibleTasks();
  const allTasks = useStore((s) => s.currentTasks);
  const projects = useStore((s) => s.projects);
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);

  const projName = (id: string | null) => projects.find((p) => p.id === id)?.name;
  const childrenOf = (id: string) => allTasks.filter((t) => t.parent_id === id);

  const parents = tasks.filter((t) => !t.parent_id);
  const pending = parents.filter((t) => !t.done);
  const done = parents.filter((t) => t.done);

  const onAddSub = async (e: React.MouseEvent, parent: Task) => {
    e.stopPropagation();
    const title = window.prompt(`Subtask of "${parent.title}"`)?.trim();
    if (title) await addSubtask(parent.id, title);
  };

  const Row = ({ t, sub = false }: { t: Task; sub?: boolean }) => {
    const kids = sub ? [] : childrenOf(t.id);
    const doneKids = kids.filter((k) => k.done).length;
    return (
      <>
        <div className={`lv-row ${t.done ? 'is-done' : ''} ${sub ? 'is-sub' : ''}`} onClick={() => setTaskModalOpen(true, t)}>
          <button
            className={`card-check ${t.done ? 'checked' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleTaskDone(t.id); }}
          >
            <i className="fa-solid fa-check"></i>
          </button>
          <span className={`lv-dot ${t.priority}`}></span>
          <span className="lv-title">{t.title}</span>
          {kids.length > 0 && <span className="lv-sub-badge"><i className="fa-solid fa-list-ul"></i> {doneKids}/{kids.length}</span>}
          {t.project_id && <span className="lv-chip">{projName(t.project_id)}</span>}
          {t.recurrence !== 'none' && <span className="lv-chip"><i className="fa-solid fa-repeat"></i> {t.recurrence}</span>}
          {t.deadline && <span className={`lv-date ${isOverdue(t.deadline) && !t.done ? 'overdue' : ''}`}>{fmtDate(t.deadline)}</span>}
          <div className="lv-actions" onClick={(e) => e.stopPropagation()}>
            {!sub && <button className="icon-btn" title="Add subtask" onClick={(e) => onAddSub(e, t)}><i className="fa-solid fa-diagram-next"></i></button>}
            <button className="icon-btn del" title="Delete" onClick={() => removeTask(t.id)}><i className="fa-solid fa-trash-can"></i></button>
          </div>
        </div>
        {kids.map((k) => <Row key={k.id} t={k} sub />)}
      </>
    );
  };

  return (
    <div className="list-view">
      {parents.length === 0 && (
        <div className="empty-state"><div className="empty-emoji">📋</div><p>No tasks here yet.</p></div>
      )}
      {pending.length > 0 && (
        <div className="lv-group">
          <div className="lv-group-hd">Open <span className="col-count">{pending.length}</span></div>
          {pending.map((t) => <Row key={t.id} t={t} />)}
        </div>
      )}
      {done.length > 0 && (
        <div className="lv-group">
          <div className="lv-group-hd">Completed <span className="col-count">{done.length}</span></div>
          {done.map((t) => <Row key={t.id} t={t} />)}
        </div>
      )}
    </div>
  );
}
