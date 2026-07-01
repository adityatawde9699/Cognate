import { useEffect, useRef, useMemo, useState } from 'react';
import { useStore, type Task, type CalendarEvent } from '../store';
import {
  planDay,
  enrichScheduling,
  getWorkHours,
  fmtClock,
  minutesOf,
  isoAt,
  DEFAULT_WORK_START,
  DEFAULT_WORK_END,
} from '../services/planService';
import { syncCalendarUrl, importBusyText, setCalendarUrl } from '../services/calendarSyncService';
import { toggleTaskDone } from '../services/taskService';
import {
  getCalendarEvents,
  createCalendarEvent,
  deleteCalendarEvent,
  updateScheduling,
  setSchedule,
} from '../db';
import { advisePlan } from '../services/aiService';
import { ChiefOfStaff } from './ChiefOfStaff';
import { toast } from '../utils/toast';

// Padding reserved at top/bottom of the timeline canvas (px)
const PAD_TOP = 10;
const PAD_BOT = 16;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function prettyDate(date: string): string {
  return new Date(date + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const ENERGY_LABEL: Record<string, string> = { hi: 'High energy', med: 'Medium energy', lo: 'Low energy' };

export function PlanView() {
  const tasks = useStore((s) => s.currentTasks);
  const setTaskModalOpen = useStore((s) => s.setTaskModalOpen);

  const [date, setDate] = useState(todayStr());
  const [work, setWork] = useState({ start: DEFAULT_WORK_START, end: DEFAULT_WORK_END });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [planning, setPlanning] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastOverflow, setLastOverflow] = useState<string[]>([]);
  const [drag, setDrag] = useState<{ id: string; dur: number; startY: number; origMin: number; curMin: number } | null>(null);
  const [note, setNote] = useState('');
  const [briefing, setBriefing] = useState(false);
  // Measured inner height of the timeline container (px). Drives pxPerMin so
  // the full work day always fits without scrolling.
  const [containerH, setContainerH] = useState(0);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getWorkHours().then(setWork);
    const onChange = () => getWorkHours().then(setWork);
    window.addEventListener('settings-changed', onChange);
    return () => window.removeEventListener('settings-changed', onChange);
  }, []);
  const refreshEvents = async () => setEvents(await getCalendarEvents());
  useEffect(() => { refreshEvents(); }, []);

  // Keep containerH in sync with the timeline wrapper's rendered height.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerH(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Tasks the planner has placed on this date.
  // Completed tasks intentionally keep their scheduled_start in the DB as a
  // historical record, but we must NOT render them as plan blocks — otherwise
  // old blocks and new blocks overlap at the same time slot.
  const scheduled = useMemo(
    () =>
      tasks
        .filter(
          (t) =>
            !t.deleted_at &&
            t.scheduled_start &&
            String(t.scheduled_start).slice(0, 10) === date
        )
        .map((t) => ({
          task: t,
          start: minutesOf(t.scheduled_start!),
          end: t.scheduled_end ? minutesOf(t.scheduled_end) : minutesOf(t.scheduled_start!) + 30,
        }))
        .sort((a, b) => a.start - b.start),
    [tasks, date]
  );

  const busyToday = useMemo(
    () =>
      events
        .filter((e) => String(e.start).slice(0, 10) === date)
        .map((e) => ({ ev: e, start: minutesOf(e.start), end: minutesOf(e.end) }))
        .filter((b) => b.end > b.start),
    [events, date]
  );

  // Open tasks not placed on this date — the backlog the planner can pull from.
  const unplanned = useMemo(
    () => tasks.filter((t) => !t.done && !t.parent_id && !t.deleted_at && !(t.scheduled_start && String(t.scheduled_start).slice(0, 10) === date)),
    [tasks, date]
  );

  const hours: number[] = [];
  for (let m = work.start; m <= work.end; m += 60) hours.push(m);

  // pxPerMin fills the measured container exactly — no overflow, no scroll.
  // Fall back to 1.4 before the first measurement arrives.
  const workMinutes = work.end - work.start;
  const pxPerMin = containerH > 0
    ? Math.max(0.6, (containerH - PAD_TOP - PAD_BOT) / workMinutes)
    : 1.4;

  // Pixel helpers — all positioned children share these.
  const toY  = (min: number) => PAD_TOP + (min - work.start) * pxPerMin;
  const toH  = (mins: number) => Math.max(mins * pxPerMin, 28);
  // Total canvas height exactly matches the container so no scrollbar appears.
  const dayHeight = containerH > 0 ? containerH : workMinutes * 1.4 + PAD_TOP + PAD_BOT;

  const handleAutoPlan = async () => {
    setPlanning(true);
    try {
      const result = await planDay(date);
      const r: Record<string, string> = {};
      result.blocks.forEach((b) => (r[b.task_id] = b.reason));
      setReasons(r);
      setLastOverflow(result.unscheduled.map((u) => u.task_id));
      const n = result.blocks.length;
      toast(
        result.unscheduled.length
          ? `🗓 Planned ${n} task${n === 1 ? '' : 's'} · ${result.unscheduled.length} didn't fit`
          : `🗓 Your day is planned — ${n} task${n === 1 ? '' : 's'}`
      );
    } catch (e: any) {
      toast(`Planning failed: ${e?.message || e}`);
    } finally {
      setPlanning(false);
    }
  };

  // AI advisor: size durations + infer energy, then re-plan with sharper inputs.
  const handleEnrich = async () => {
    setEnriching(true);
    try {
      const n = await enrichScheduling();
      toast(n ? `✨ Estimated ${n} task${n === 1 ? '' : 's'} — re-planning…` : '✨ Everything was already sized');
      await handleAutoPlan();
    } catch (e: any) {
      toast(e?.message || 'AI estimate unavailable');
    } finally {
      setEnriching(false);
    }
  };

  // Pull real meetings from an .ics subscription (desktop) or pasted .ics text.
  const handleSyncCalendar = async () => {
    const input = window.prompt(
      'Subscribe to a calendar: paste an .ics URL (desktop), or paste .ics text to import once.'
    )?.trim();
    if (!input) return;
    setSyncing(true);
    try {
      let count: number;
      if (/BEGIN:VCALENDAR/i.test(input)) {
        count = await importBusyText(input);
      } else {
        await setCalendarUrl(input);
        count = await syncCalendarUrl(input);
      }
      await refreshEvents();
      toast(`📅 Imported ${count} calendar event${count === 1 ? '' : 's'}`);
    } catch (e: any) {
      toast(e?.message || 'Calendar sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const togglePin = async (t: Task) => {
    await updateScheduling(t.id, { duration_min: t.duration_min ?? 0, energy: (t.energy as any) || 'med', pinned: !t.pinned });
    useStore.getState().updateTaskOptimistic(t.id, { pinned: !t.pinned } as Partial<Task>);
  };

  // ── Drag a block to a new time → pin it there → re-solve the rest ──
  const SNAP = 15;
  const onGripDown = (e: React.PointerEvent, taskId: string, startMin: number, endMin: number) => {
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ id: taskId, dur: Math.max(endMin - startMin, SNAP), startY: e.clientY, origMin: startMin, curMin: startMin });
  };
  const onGripMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const delta = (e.clientY - drag.startY) / pxPerMin;
    let m = Math.round((drag.origMin + delta) / SNAP) * SNAP;
    m = Math.max(work.start, Math.min(work.end - drag.dur, m));
    if (m !== drag.curMin) setDrag({ ...drag, curMin: m });
  };
  const onGripUp = async (e: React.PointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (d.curMin === d.origMin) return; // a click, not a drag
    const start = isoAt(date, d.curMin);
    const end = isoAt(date, d.curMin + d.dur);
    const t = scheduled.find((s) => s.task.id === d.id)?.task;
    await updateScheduling(d.id, { duration_min: d.dur, energy: (t?.energy as any) || 'med', pinned: true });
    await setSchedule(d.id, start, end);
    useStore.getState().updateTaskOptimistic(d.id, { pinned: true, scheduled_start: start, scheduled_end: end } as Partial<Task>);
    toast('📌 Pinned — re-planning around it');
    await handleAutoPlan(); // pinned block holds; everything else re-solves around it
  };

  // ── AI chief-of-staff brief on the current plan ──
  const handleBrief = async () => {
    setBriefing(true);
    try {
      const blocks = scheduled.map((s) => ({
        title: s.task.title,
        start: fmtClock(s.start),
        end: fmtClock(s.end),
        reason: reasons[s.task.id],
      }));
      const overflow = unplanned.filter((t) => lastOverflow.includes(t.id)).map((t) => t.title);
      setNote(await advisePlan(date, blocks, overflow));
    } catch (err: any) {
      toast(err?.message || 'Brief unavailable');
    } finally {
      setBriefing(false);
    }
  };

  const addBusy = async () => {
    const title = window.prompt('Busy with what? (e.g. "Client call")')?.trim();
    if (title === undefined) return;
    const startStr = window.prompt('Start time (HH:MM, 24h)', '14:00');
    const endStr = window.prompt('End time (HH:MM, 24h)', '15:00');
    const s = startStr ? parseClock(startStr) : null;
    const e = endStr ? parseClock(endStr) : null;
    if (s == null || e == null || e <= s) { toast('Enter a valid time range'); return; }
    await createCalendarEvent({ title: title || 'Busy', start: isoAt(date, s), end: isoAt(date, e), source: 'manual' });
    await refreshEvents();
  };

  const removeBusy = async (id: string) => {
    await deleteCalendarEvent(id);
    await refreshEvents();
  };

  return (
    <section className="plan-view" aria-label="Plan">
      <header className="plan-header">
        <div className="plan-heading">
          <div className="plan-eyebrow"><i className="fa-regular fa-calendar-check"></i> Your day, planned</div>
          <h1 className="plan-title">{prettyDate(date)}</h1>
          <p className="plan-sub">
            {fmtClock(work.start)}–{fmtClock(work.end)}
            <span className="plan-sub-dot" />
            {scheduled.length} scheduled
            <span className="plan-sub-dot" />
            {unplanned.length} in backlog
          </p>
        </div>
        <div className="plan-actions">
          <div className="plan-datenav">
            <button className="btn-ghost" onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day"><i className="fa-solid fa-chevron-left"></i></button>
            <button className="btn-ghost" onClick={() => setDate(todayStr())}>Today</button>
            <button className="btn-ghost" onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day"><i className="fa-solid fa-chevron-right"></i></button>
          </div>
          <button className="btn-ghost" onClick={addBusy} title="Add a busy block"><i className="fa-solid fa-plus"></i> Busy time</button>
          <button className="btn-ghost plan-sync" onClick={handleSyncCalendar} disabled={syncing} title="Subscribe to or import a calendar (.ics)">
            <i className={`fa-solid ${syncing ? 'fa-spinner fa-spin' : 'fa-calendar-plus'}`}></i>
            <span>{syncing ? 'Syncing…' : 'Sync calendar'}</span>
          </button>
          <button className="btn-ghost plan-enrich" onClick={handleEnrich} disabled={enriching || planning} title="Let AI estimate durations and energy, then re-plan">
            <i className={`fa-solid ${enriching ? 'fa-spinner fa-spin' : 'fa-brain'}`}></i>
            <span>{enriching ? 'Estimating…' : 'AI estimate'}</span>
          </button>
          <button className="btn-ghost plan-brief" onClick={handleBrief} disabled={briefing || scheduled.length === 0} title="Ask your AI chief of staff to brief you on the day">
            <i className={`fa-solid ${briefing ? 'fa-spinner fa-spin' : 'fa-comment-dots'}`}></i>
            <span>{briefing ? 'Briefing…' : 'Brief me'}</span>
          </button>
          <button className="btn-primary plan-autoplan" onClick={handleAutoPlan} disabled={planning}>
            <i className={`fa-solid ${planning ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
            <span>{planning ? 'Planning…' : 'Auto-plan'}</span>
          </button>
        </div>
      </header>

      {note && (
        <div className="plan-note" role="status">
          <i className="fa-solid fa-user-tie"></i>
          <p>{note}</p>
          <button className="plan-note-x" onClick={() => setNote('')} aria-label="Dismiss"><i className="fa-solid fa-xmark"></i></button>
        </div>
      )}

      <ChiefOfStaff date={date} />

      <div className="plan-body">
        <div className="plan-timeline-wrap" ref={timelineRef}>
        <div className="plan-timeline" style={{ height: `${dayHeight}px` }}>
          {hours.map((m) => (
            <div key={m} className="plan-hour" style={{ top: `${toY(m)}px` }}>
              <span className="plan-hour-label">{fmtClock(m)}</span>
              <span className="plan-hour-line" />
            </div>
          ))}

          {busyToday.map(({ ev, start, end }) => (
            <div
              key={ev.id}
              className="plan-busy"
              style={{ top: `${toY(start)}px`, height: `${toH(end - start)}px` }}
              title={`${ev.title} · ${fmtClock(start)}–${fmtClock(end)}`}
            >
              <span className="plan-busy-title"><i className="fa-solid fa-lock"></i> {ev.title || 'Busy'}</span>
              <span className="plan-busy-time">{fmtClock(start)}–{fmtClock(end)}</span>
              {ev.source === 'manual' && (
                <button className="plan-busy-del" onClick={() => removeBusy(ev.id)} aria-label="Remove busy block"><i className="fa-solid fa-xmark"></i></button>
              )}
            </div>
          ))}

          {scheduled.map(({ task, start, end }) => {
            const dragging = drag?.id === task.id;
            const top = dragging ? drag!.curMin : start;
            const blkEnd = dragging ? drag!.curMin + drag!.dur : end;
            return (
              <div
                key={task.id}
                className={`plan-block prio-${task.priority} ${dragging ? 'is-dragging' : ''} ${task.done ? 'is-done' : ''}`}
                style={{ top: `${toY(top)}px`, height: `${toH(blkEnd - top)}px` }}
                onClick={() => { if (!dragging) setTaskModalOpen(true, task); }}
                role="button"
                tabIndex={0}
                title={ENERGY_LABEL[task.energy || 'med']}
              >
                <div className="plan-block-top">
                  <button
                    className={`plan-check ${task.done ? 'checked' : ''}`}
                    onClick={(e) => { e.stopPropagation(); toggleTaskDone(task.id); }}
                    role="checkbox"
                    aria-checked={task.done}
                    aria-label={task.done ? `Mark "${task.title}" not done` : `Mark "${task.title}" done`}
                    title={task.done ? 'Mark not done' : 'Mark done'}
                  >
                    <i className="fa-solid fa-check"></i>
                  </button>
                  <span
                    className="plan-grip"
                    title="Drag to reschedule"
                    aria-label="Drag to reschedule"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => onGripDown(e, task.id, start, end)}
                    onPointerMove={onGripMove}
                    onPointerUp={onGripUp}
                  >
                    <i className="fa-solid fa-grip-vertical"></i>
                  </span>
                  <span className="plan-block-title">{task.title}</span>
                  <button
                    className={`plan-pin ${task.pinned ? 'is-pinned' : ''}`}
                    onClick={(e) => { e.stopPropagation(); togglePin(task); }}
                    title={task.pinned ? 'Unpin (let the planner move it)' : 'Pin to this time'}
                    aria-label={task.pinned ? 'Unpin task' : 'Pin task'}
                  >
                    <i className="fa-solid fa-thumbtack"></i>
                  </button>
                </div>
                <span className="plan-block-time">{fmtClock(top)}–{fmtClock(blkEnd)}</span>
                {reasons[task.id] && <span className="plan-block-why">{reasons[task.id]}</span>}
              </div>
            );
          })}

          {scheduled.length === 0 && busyToday.length === 0 && (
            <div className="plan-empty">
              <i className="fa-regular fa-calendar"></i>
              <p>Nothing scheduled yet.</p>
              <p className="plan-empty-sub">Hit <strong>Auto-plan</strong> and your day lays itself out.</p>
            </div>
          )}
        </div>
        </div>{/* plan-timeline-wrap */}

        <aside className="plan-backlog">
          <h3>Backlog <span className="plan-backlog-count">{unplanned.length}</span></h3>
          {unplanned.length === 0 ? (
            <p className="plan-backlog-empty">Everything's on the calendar. ✨</p>
          ) : (
            <ul className="plan-backlog-list">
              {unplanned.map((t) => (
                <li
                  key={t.id}
                  className={`plan-backlog-item prio-${t.priority} ${lastOverflow.includes(t.id) ? 'is-overflow' : ''}`}
                  onClick={() => setTaskModalOpen(true, t)}
                >
                  <span className="plan-backlog-title">{t.title}</span>
                  <span className="plan-backlog-meta">
                    {lastOverflow.includes(t.id) && <span className="plan-overflow-tag">didn't fit</span>}
                    {t.deadline && <span><i className="fa-regular fa-calendar"></i> {t.deadline.slice(5)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </section>
  );
}
