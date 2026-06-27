import { useStore } from '../store';
import { addMilestone, removeMilestone } from '../services/taskService';

export function MilestoneStrip() {
  const milestones = useStore((s) => s.milestones);
  const tasks = useStore((s) => s.currentTasks);
  const currentFilter = useStore((s) => s.currentFilter);
  const setFilter = useStore((s) => s.setFilter);

  const progress = (id: string) => {
    const mine = tasks.filter((t) => t.milestone_id === id);
    const done = mine.filter((t) => t.done).length;
    return { done, total: mine.length, pct: mine.length ? Math.round((done / mine.length) * 100) : 0 };
  };

  const onAdd = async () => {
    const name = window.prompt('Milestone name')?.trim();
    if (name) await addMilestone(name, null, '');
  };

  const onDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (window.confirm(`Delete milestone "${name}"? Tasks are kept.`)) {
      if (currentFilter === `milestone:${id}`) setFilter('all');
      await removeMilestone(id);
    }
  };

  if (milestones.length === 0) return null;

  return (
    <div className="mile-strip">
      <span className="mile-label"><i className="fa-solid fa-flag-checkered"></i> Milestones</span>
      <div className="mile-pills">
        {milestones.map((m) => {
          const p = progress(m.id);
          const active = currentFilter === `milestone:${m.id}`;
          return (
            <button
              key={m.id}
              className={`mile-pill ${active ? 'active' : ''}`}
              onClick={() => setFilter(active ? 'all' : `milestone:${m.id}`)}
              title={`${p.done}/${p.total} done`}
            >
              <span className="mile-name">{m.name}</span>
              <span className="mile-bar"><span className="mile-fill" style={{ width: `${p.pct}%` }}></span></span>
              <span className="mile-count">{p.pct}%</span>
              <span className="mile-del" onClick={(e) => onDelete(e, m.id, m.name)}><i className="fa-solid fa-xmark"></i></span>
            </button>
          );
        })}
      </div>
      <button className="mile-add" onClick={onAdd} title="New milestone"><i className="fa-solid fa-plus"></i></button>
    </div>
  );
}
