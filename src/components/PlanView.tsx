import { useEffect, useMemo, useRef, useState } from 'react';
import {
    initDb,
    getPlanningSnapshot,
    createCalendarEvent,
    deleteCalendarEvent,
    getCalendarEvents,
    updateScheduling,
} from '../db';
import { advisePlan } from '../services/aiService';
import { calendarWarnings, importBusyText, setCalendarUrl, syncCalendarUrl } from '../services/calendarSyncService';
import {
    DEFAULT_WORK_END,
    DEFAULT_WORK_START,
    enrichScheduling,
    busyBlocksForDate,
    fmtClock,
    getWorkHours,
    isoAt,
    minutesOf,
    planDay,
    PlanRefreshError,
} from '../services/planService';
import { toggleTaskDone } from '../services/taskService';
import { useStore, type CalendarEvent, type Task } from '../store';
import { toast } from '../utils/toast';
import { reviewPlan, type PlanReview } from '../services/planReview';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { ChiefOfStaff } from './ChiefOfStaff';

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
  const [calendarStatus,setCalendarStatus]=useState<string[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [planning, setPlanning] = useState(false);
  const [review, setReview] = useState<PlanReview | null>(null);
  const [actionError, setActionError] = useState('');
  const [move, setMove] = useState<{task:Task;time:string;duration:number} | null>(null);
  const [moveError,setMoveError] = useState('');
  const moveRef=useRef<HTMLDivElement>(null);
  const moveTrigger=useRef<HTMLElement | null>(null);
  useEffect(()=>{if(!move && moveTrigger.current?.isConnected) {moveTrigger.current.focus();moveTrigger.current=null;}},[move]);
  useFocusTrap(moveRef, Boolean(move));
  const [enriching, setEnriching] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(()=>{ calendarWarnings(date).then(setCalendarStatus).catch(()=>setCalendarStatus(['Calendar status unavailable. Refresh before planning.'])); },[date, syncing]);

  const [lastOverflow, setLastOverflow] = useState<string[]>([]);
  const [drag, setDrag] = useState<{ id: string; dur: number; startY: number; origMin: number; curMin: number } | null>(null);
  const [note, setNote] = useState('');
  const [briefing, setBriefing] = useState(false);
  // Measured inner height of the timeline container (px). Drives pxPerMin so
  // the day fills the container when it can, and scrolls when it can't.
  const [containerH, setContainerH] = useState(0);
  const [narrow,setNarrow]=useState(false);
  const [toolsOpen,setToolsOpen]=useState(false);
  useEffect(()=>{
    const media=window.matchMedia('(max-width: 768px)');
    const update=()=>setNarrow(media.matches);update();media.addEventListener('change',update);
    return ()=>media.removeEventListener('change',update);
  },[]);
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [nowMin, setNowMin] = useState(() => new Date().getHours() * 60 + new Date().getMinutes());

  useEffect(() => {
    const id = setInterval(() => setNowMin(new Date().getHours() * 60 + new Date().getMinutes()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    getWorkHours().then(setWork);
    const onChange = () => getWorkHours().then(setWork);
    window.addEventListener('settings-changed', onChange);
    return () => window.removeEventListener('settings-changed', onChange);
  }, []);
  const refreshEvents = async () => setEvents(await getCalendarEvents());
  useEffect(() => {
    const update=()=>{void refreshEvents();void calendarWarnings(date).then(setCalendarStatus);};
    update();window.addEventListener('calendar-changed',update);
    return ()=>window.removeEventListener('calendar-changed',update);
  }, [date]);
  useEffect(() => {
    let active=true, generation=0;
    const refresh=async()=>{
      const turn=++generation;
      try {
        await initDb();
        const snapshot=await getPlanningSnapshot();
        if(!active || turn!==generation) return;
        const next=reviewPlan(snapshot,date);
        setReview(next);setReasons(next.reasons);setLastOverflow(next.unscheduled.map(u=>u.task_id));
      } catch {
        if(active && turn===generation) setReview({state:'invalid',message:'Plan status unavailable. Your existing schedule is preserved; retry after checking storage.',reasons:{},unscheduled:[]});
      }
    };
    setReview(null);void refresh();
    const changed=()=>void refresh();
    window.addEventListener('plan-changed',changed);
    window.addEventListener('calendar-changed',changed);
    window.addEventListener('settings-changed',changed);
    window.addEventListener('focus',changed);
    return ()=>{active=false;window.removeEventListener('plan-changed',changed);window.removeEventListener('calendar-changed',changed);window.removeEventListener('settings-changed',changed);window.removeEventListener('focus',changed);};
  },[date,tasks]);

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
      events.flatMap(ev => busyBlocksForDate([ev],date).map(block => ({ev,start:block.start_min,end:block.end_min}))),
    [events, date]
  );

  // Open tasks not placed on this date — the backlog the planner can pull from.
  const unplanned = useMemo(
    () => tasks.filter((t) => !t.done && !t.parent_id && !t.deleted_at && !(t.scheduled_start && String(t.scheduled_start).slice(0, 10) === date)),
    [tasks, date]
  );

  const hours: number[] = [];
  for (let m = work.start; m <= work.end; m += 60) hours.push(m);

  // pxPerMin fills the measured container when the day fits, but never drops
  // below a floor that keeps a 30-minute block legible — long days scroll
  // instead of crushing blocks into each other.
  // Fall back to 1.4 before the first measurement arrives.
  const MIN_PX_PER_MIN = narrow ? 3.6 : 1.1;
  const workMinutes = work.end - work.start;
  const pxPerMin = containerH > 0
    ? Math.max(MIN_PX_PER_MIN, (containerH - PAD_TOP - PAD_BOT) / workMinutes)
    : 1.4;

  // Pixel helpers — all positioned children share these.
  const toY  = (min: number) => PAD_TOP + (min - work.start) * pxPerMin;
  const toH  = (mins: number) => Math.max(mins * pxPerMin, 24);
  // True canvas height; equals the container when the day fits, else scrolls.
  const dayHeight = Math.round(workMinutes * pxPerMin + PAD_TOP + PAD_BOT);

  const isToday = date === todayStr();
  const showNow = isToday && nowMin >= work.start && nowMin <= work.end;

  // Keep the interesting part of the day in view: first block, else "now".
  const firstStart = scheduled.length ? scheduled[0].start : null;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    const anchor = firstStart ?? (showNow ? nowMin : work.start);
    el.scrollTop = Math.max(0, PAD_TOP + (anchor - work.start) * pxPerMin - 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstStart, date, containerH, work.start]);

  const handleAutoPlan = async () => {
    if(planning) return;
    setActionError('');
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
      setActionError(e instanceof PlanRefreshError ? e.message : `Planning failed: ${e?.message || e}. Your previous plan is preserved.`);
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
      // Tauri may reject with a string, a plain object, or an Error. Preserve
      // the actionable provider message instead of reducing it to a generic
      // failure that gives the user no way to fix the setup.
      const message = typeof e === 'string'
        ? e
        : e?.message || e?.error || e?.cause?.message || String(e || '');
      toast(message && message !== '[object Object]'
        ? `AI estimate unavailable: ${message}`
        : 'AI estimate unavailable. Open Settings → AI and configure a provider, API key, model, or local server.');
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
    try {
    await updateScheduling(t.id, { duration_min: t.duration_min ?? 0, energy: (t.energy as any) || 'med', pinned: !t.pinned });
    useStore.getState().updateTaskOptimistic(t.id, { pinned: !t.pinned } as Partial<Task>);
    } catch(error) {setActionError(error instanceof Error ? error.message : 'Pin could not be saved.');}
  };

  // ── Drag a block to a new time → pin it there → re-solve the rest ──
  const SNAP = 15;
  const onGripDown = (e: React.PointerEvent, taskId: string, startMin: number, endMin: number) => {
    e.stopPropagation();
    e.preventDefault();
    if(planning || move) return;
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
    setPlanning(true);
    try {
      const result = await planDay(date,{pin:{taskId:d.id,startMin:d.curMin,durationMin:d.dur}});
      setReasons(Object.fromEntries(result.blocks.map(block=>[block.task_id,block.reason])));
      setLastOverflow(result.unscheduled.map(item=>item.task_id));
      toast('📌 Pinned — plan updated');
    } catch(error) {toast(error instanceof Error ? error.message : 'Move could not be saved.');}
    finally {setPlanning(false);}
  };

  const openMove=(task:Task,start:number,end:number)=>{
    moveTrigger.current=document.activeElement as HTMLElement;
    setMoveError('');setMove({task,time:`${String(Math.floor(start/60)).padStart(2,'0')}:${String(start%60).padStart(2,'0')}`,duration:end-start});
  };
  const saveMove=async(e:React.FormEvent)=>{
    e.preventDefault();if(!move || planning) return;
    const start=parseClock(move.time);
    if(start===null || start<0 || start>=1440 || !Number.isInteger(move.duration) || move.duration<15 || move.duration>1440) {setMoveError('Enter a valid time and a duration of 15–1440 minutes.');return;}
    setPlanning(true);setMoveError('');
    try {
      await planDay(date,{pin:{taskId:move.task.id,startMin:start,durationMin:move.duration}});
      setMove(null);toast('Pinned time saved; remaining tasks re-planned.');
    } catch(error) {if(error instanceof PlanRefreshError) {setMove(null);setActionError(error.message);} else setMoveError(error instanceof Error ? error.message : 'Move could not be saved. Your input is preserved.');}
    finally {setPlanning(false);}
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
          {calendarStatus.length>0 && <p role="status">{calendarStatus.join(' ')}</p>}
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
            <button className="btn-ghost" disabled={planning} onClick={() => setDate(shiftDate(date, -1))} aria-label="Previous day"><i className="fa-solid fa-chevron-left"></i></button>
            <button className="btn-ghost" disabled={planning} onClick={() => setDate(todayStr())}>Today</button>
            <button className="btn-ghost" disabled={planning} onClick={() => setDate(shiftDate(date, 1))} aria-label="Next day"><i className="fa-solid fa-chevron-right"></i></button>
          </div>
          <button className="btn-ghost plan-capture" onClick={()=>setTaskModalOpen(true)}><i className="fa-solid fa-plus" aria-hidden="true" /> Capture task</button>
          <button className="btn-primary plan-autoplan" onClick={handleAutoPlan} disabled={planning}>
            <i className={`fa-solid ${planning ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'}`}></i>
            <span>{planning ? 'Planning…' : 'Auto-plan'}</span>
          </button>
        </div>
      </header>
      <details className="plan-toolbox" open={!narrow || toolsOpen} onToggle={e=>{if(narrow)setToolsOpen(e.currentTarget.open);}}>
        <summary>Planning tools <span>Calendar & AI</span><i className="fa-solid fa-chevron-down" aria-hidden="true" /></summary>
        <div className="plan-tools" aria-label="Planning tools">
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
          <button className="btn-ghost plan-inbox" onClick={()=>useStore.getState().setFilter('all')}>Review inbox <i className="fa-solid fa-arrow-right" aria-hidden="true" /></button>
        </div>
      </details>
      <p className={`plan-review ${review?.state || 'loading'}`} role="status">
        <i className={`fa-solid ${review?.state === 'current' ? 'fa-circle-check' : review?.state === 'stale' || review?.state === 'invalid' ? 'fa-circle-exclamation' : 'fa-circle-info'}`} aria-hidden="true" />
        <span>{review?.message || 'Checking saved plan…'}</span>
      </p>
      {actionError && <p className="plan-action-error" role="alert">{actionError}</p>}

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
        <div className="plan-section-heading"><h2>Schedule</h2><span>Local time</span></div>
        <div className="plan-timeline" ref={scrollerRef}>
        <div className="plan-canvas" style={{ height: `${dayHeight}px` }}>
          {hours.map((m) => (
            <div key={m} className={`plan-hour ${showNow && Math.floor(nowMin / 60) === Math.floor(m / 60) ? 'is-now' : ''}`} style={{ top: `${toY(m)}px` }}>
              <span className="plan-hour-label">{fmtClock(m)}</span>
              <span className="plan-hour-line" />
            </div>
          ))}

          {showNow && (
            <div className="plan-now" style={{ top: `${toY(nowMin)}px` }} aria-hidden="true">
              <span className="plan-now-dot" />
            </div>
          )}

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
            const h = toH(blkEnd - top);
            return (
              <div
                key={task.id}
                className={`plan-block prio-${task.priority} ${h < 46 ? 'is-compact' : ''} ${dragging ? 'is-dragging' : ''} ${task.done ? 'is-done' : ''}`}
                style={{ top: `${toY(top)}px`, height: `${Math.max(h - 2, 22)}px` }}
                role="group"
                aria-label={`${task.title}, ${fmtClock(top)} to ${fmtClock(blkEnd)}`}
                title={ENERGY_LABEL[task.energy || 'med']}
              >
                <div className="plan-block-top">
                  <button
                    className={`plan-check ${task.done ? 'checked' : ''}`}
                    onClick={(e) => { e.stopPropagation(); void toggleTaskDone(task.id).catch(error=>setActionError(String(error))); }}
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
                    aria-hidden="true"
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => onGripDown(e, task.id, start, end)}
                    onPointerMove={onGripMove}
                    onPointerUp={onGripUp}
                  >
                    <i className="fa-solid fa-grip-vertical"></i>
                  </span>
                  <button className="plan-block-title" onClick={()=>setTaskModalOpen(true,task)} aria-label={`Edit ${task.title}`}>{task.title}</button>
                  {!task.done && <button className="plan-move" onClick={()=>openMove(task,start,end)} disabled={planning} aria-label={`Reschedule ${task.title}`}>Move</button>}
                  <button
                    className={`plan-pin ${task.pinned ? 'is-pinned' : ''}`}
                    onClick={(e) => { e.stopPropagation(); togglePin(task); }}
                    title={task.pinned ? 'Unpin (let the planner move it)' : 'Pin to this time'}
                    aria-label={task.pinned ? 'Unpin task' : 'Pin task'}
                    aria-pressed={Boolean(task.pinned)}
                    disabled={planning}
                  >
                    <i className="fa-solid fa-thumbtack"></i>
                  </button>
                </div>
                <span className="plan-block-time">{fmtClock(top)}–{fmtClock(blkEnd)}</span>
                {reasons[task.id] && <span className="plan-block-why">{reasons[task.id]}</span>}
              </div>
            );
          })}

        </div>{/* plan-canvas */}

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
          <p className="plan-backlog-hint">Tasks waiting for a place in your day.</p>
          {unplanned.length === 0 ? (
            <p className="plan-backlog-empty">Everything's on the calendar. ✨</p>
          ) : (
            <ul className="plan-backlog-list">
              {unplanned.map((t) => (
                <li
                  key={t.id}
                  className={`plan-backlog-item prio-${t.priority} ${lastOverflow.includes(t.id) ? 'is-overflow' : ''}`}
                >
                  <button className="plan-backlog-title" onClick={()=>setTaskModalOpen(true,t)} aria-label={`Review ${t.title}`}>{t.title}</button>
                  <span className="plan-backlog-meta">
                    {lastOverflow.includes(t.id) && <span className="plan-overflow-tag">{review?.unscheduled.find(u=>u.task_id===t.id)?.reason || "didn't fit"}</span>}
                    {t.deadline && <span><i className="fa-regular fa-calendar"></i> {t.deadline.slice(5)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
      {move && <div className="modal-overlay open">
        <div className="modal-panel plan-move-dialog" ref={moveRef} role="dialog" aria-modal="true" aria-labelledby="move-title" onKeyDown={e=>{if(e.key==='Escape' && !planning) {e.stopPropagation();setMove(null);}}}>
          <h2 id="move-title">Reschedule {move.task.title}</h2>
          <p>Choose a time. This task will be pinned and the remaining plan updated together.</p>
          <form onSubmit={saveMove}>
            <label htmlFor="move-time">Start time</label><input id="move-time" type="time" value={move.time} onChange={e=>setMove({...move,time:e.target.value})} required autoFocus />
            <label htmlFor="move-duration">Duration (minutes)</label><input id="move-duration" type="number" min="15" max="1440" value={move.duration} onChange={e=>setMove({...move,duration:Number(e.target.value)})} required />
            {moveError && <p role="alert">{moveError}</p>}
            <div className="plan-actions"><button type="button" className="btn-ghost" disabled={planning} onClick={()=>setMove(null)}>Cancel</button><button type="submit" className="btn-primary" disabled={planning}>{planning?'Saving…':'Save and pin'}</button></div>
          </form>
        </div>
      </div>}
    </section>
  );
}
