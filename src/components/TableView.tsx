import { useStore } from '../store';
import { useVisibleTasks } from '../hooks/useVisibleTasks';
import { toggleTaskDone } from '../services/taskService';
import { fmtDate, isOverdue } from '../utils/format';

const P_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function TableView() {
  const tasks = useVisibleTasks();
  const projects = useStore((s) => s.projects);
  const customFieldDefs = useStore((s) => s.customFieldDefs);
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);
  const projName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? '—';

  return (
    <div className="table-view">
      <table className="tv">
        <thead>
          <tr>
            <th className="tv-check"></th>
            <th>Task</th>
            <th>Project</th>
            <th>Priority</th>
            <th>Deadline</th>
            <th>Focus</th>
            {customFieldDefs.map((f) => <th key={f.id}>{f.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {tasks.length === 0 && (
            <tr><td colSpan={6 + customFieldDefs.length} className="tv-empty">No tasks here yet.</td></tr>
          )}
          {tasks.map((t) => (
            <tr key={t.id} className={t.done ? 'is-done' : ''} onClick={() => setTaskModalOpen(true, t)}>
              <td className="tv-check" onClick={(e) => e.stopPropagation()}>
                <button className={`card-check ${t.done ? 'checked' : ''}`} onClick={() => toggleTaskDone(t.id)}>
                  <i className="fa-solid fa-check"></i>
                </button>
              </td>
              <td className="tv-title">
                {t.parent_id && <i className="fa-solid fa-turn-up tv-sub-ico"></i>}
                {t.title}
              </td>
              <td>{t.project_id ? projName(t.project_id) : <span className="tv-muted">—</span>}</td>
              <td><span className={`p-badge ${t.priority}`}><span className="p-dot"></span>{P_LABEL[t.priority]}</span></td>
              <td className={isOverdue(t.deadline) && !t.done ? 'tv-overdue' : ''}>
                {t.deadline ? fmtDate(t.deadline) : <span className="tv-muted">—</span>}
              </td>
              <td>{t.pomodoros_spent > 0 ? `${t.pomodoros_spent}×` : <span className="tv-muted">—</span>}</td>
              {customFieldDefs.map((f) => {
                const v = t.custom_fields?.[f.id];
                return (
                  <td key={f.id}>
                    {v ? (f.type === 'url' ? <a href={v} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>link</a> : v) : <span className="tv-muted">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
