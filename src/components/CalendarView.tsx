import { useState } from 'react';
import { useStore } from '../store';
import { useVisibleTasks } from '../hooks/useVisibleTasks';

function ymd(d: Date) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function CalendarView() {
  const tasks = useVisibleTasks();
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);
  const [off, setOff] = useState(0);

  const base = new Date();
  base.setDate(1);
  base.setMonth(base.getMonth() + off);
  const year = base.getFullYear();
  const month = base.getMonth();
  const startDay = new Date(year, month, 1).getDay();

  const gridStart = new Date(year, month, 1 - startDay);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });

  const byDay: Record<string, typeof tasks> = {};
  tasks.forEach((t) => { if (t.deadline) (byDay[t.deadline] ||= []).push(t); });

  const todayStr = ymd(new Date());
  const monthLabel = base.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  return (
    <div className="cal-view">
      <div className="cal-head">
        <h3>{monthLabel}</h3>
        <div className="cal-nav">
          <button className="btn-soft" onClick={() => setOff((o) => o - 1)}><i className="fa-solid fa-chevron-left"></i></button>
          <button className="btn-soft" onClick={() => setOff(0)}>Today</button>
          <button className="btn-soft" onClick={() => setOff((o) => o + 1)}><i className="fa-solid fa-chevron-right"></i></button>
        </div>
      </div>
      <div className="cal-grid">
        {WD.map((w) => <div key={w} className="cal-wd">{w}</div>)}
        {cells.map((d, i) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === month;
          const dayTasks = byDay[key] || [];
          return (
            <div key={i} className={`cal-cell ${inMonth ? '' : 'muted'} ${key === todayStr ? 'today' : ''}`}>
              <span className="cal-num">{d.getDate()}</span>
              <div className="cal-tasks">
                {dayTasks.slice(0, 3).map((t) => (
                  <button
                    key={t.id}
                    className={`cal-task ${t.priority} ${t.done ? 'done' : ''}`}
                    onClick={() => setTaskModalOpen(true, t)}
                    title={t.title}
                  >
                    {t.title}
                  </button>
                ))}
                {dayTasks.length > 3 && <span className="cal-more">+{dayTasks.length - 3} more</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
