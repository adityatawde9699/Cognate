import { useStore } from '../store';
import { useVisibleTasks } from '../hooks/useVisibleTasks';
import { fmtDate } from '../utils/format';

const DAY = 86400000;

export function TimelineView() {
  const tasks = useVisibleTasks();
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const windowStart = new Date(today.getTime() - 3 * DAY);
  const windowEnd = new Date(today.getTime() + 28 * DAY);
  const span = windowEnd.getTime() - windowStart.getTime();

  const rows = tasks
    .filter((t) => t.deadline)
    .map((t) => ({ t, dl: new Date(t.deadline + 'T00:00:00') }))
    .filter((x) => x.dl.getTime() <= windowEnd.getTime())
    .sort((a, b) => a.dl.getTime() - b.dl.getTime());

  // Weekly axis ticks
  const ticks: { left: number; label: string }[] = [];
  for (let ms = windowStart.getTime(); ms <= windowEnd.getTime(); ms += 7 * DAY) {
    ticks.push({ left: ((ms - windowStart.getTime()) / span) * 100, label: fmtDate(new Date(ms).toISOString().slice(0, 10)) });
  }
  const todayLeft = ((today.getTime() - windowStart.getTime()) / span) * 100;

  return (
    <div className="tl-view">
      <div className="tl-axis">
        <div className="tl-label-col"></div>
        <div className="tl-track-head" style={{ ['--today' as any]: `${todayLeft}%` }}>
          {ticks.map((tk, i) => <span key={i} className="tl-tick" style={{ left: `${tk.left}%` }}>{tk.label}</span>)}
        </div>
      </div>
      <div className="tl-rows">
        {rows.length === 0 && <div className="empty-state"><div className="empty-emoji">🗓️</div><p>No upcoming deadlines in this window.</p></div>}
        {rows.map(({ t, dl }) => {
          const start = t.created_at ? new Date(t.created_at) : today;
          const s = Math.max(start.getTime(), windowStart.getTime());
          const e = Math.min(Math.max(dl.getTime(), s + DAY), windowEnd.getTime());
          const left = ((s - windowStart.getTime()) / span) * 100;
          const width = Math.max(((e - s) / span) * 100, 2.5);
          const overdue = dl.getTime() < today.getTime() && !t.done;
          return (
            <div key={t.id} className="tl-row" onClick={() => setTaskModalOpen(true, t)}>
              <div className="tl-label" title={t.title}>{t.title}</div>
              <div className="tl-track" style={{ ['--today' as any]: `${todayLeft}%` }}>
                <div
                  className={`tl-bar ${t.priority} ${t.done ? 'done' : ''} ${overdue ? 'overdue' : ''}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                >
                  <span className="tl-bar-date">{fmtDate(t.deadline)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
