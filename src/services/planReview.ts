import type { PlanningSnapshot } from '../db';
import type { PlanResult } from './planService';

const workKeys = ['use_custom_work_hours', 'work_start_min', 'work_end_min', 'wake_start_min', 'wake_end_min'];
function at(date: string, min: number): string {
  const d = new Date(`${date}T00:00:00`); d.setMinutes(min);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:00`;
}
/** Semantic planner inputs, independent of row order, history clocks and other saved days. */
export function planInputKey(snapshot: PlanningSnapshot, date?: string, result?: PlanResult): string {
  const blocks = new Map(result?.blocks.map(b => [b.task_id,b]));
  const tasks = snapshot.tasks.filter(t => !t.deleted_at && !t.parent_id).map(t => {
    let start=t.scheduled_start || null, end=t.scheduled_end || null;
    let pinned=Boolean(t.pinned), duration=t.duration_min || 0;
    if (result && date && !t.done) {
      const block=blocks.get(t.id);
      if (block) { start=at(date,block.start_min); end=at(date,block.end_min); }
      else if (!pinned && start?.slice(0,10)===date) {start=null;end=null;}
      if (result.pin?.task_id===t.id) {pinned=true;duration=result.pin.duration_min;}
    }
    return {id:t.id,title:t.title,done:Boolean(t.done),deadline:t.deadline || '',importance:t.importance,priority:t.priority,energy:t.energy || 'med',duration,min:t.min_block || 0,max:t.max_block || 0,pinned,start,end};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const calendar=snapshot.calendar.map(e=>({id:e.id,start:e.start,end:e.end,source:e.source,title:e.title})).sort((a,b)=>a.id.localeCompare(b.id));
  return JSON.stringify({tasks,calendar,work:workKeys.map(key=>snapshot.settings[key] ?? null)});
}
export interface PlanReview {state:'missing'|'current'|'stale'|'invalid';message:string;reasons:Record<string,string>;unscheduled:Array<{task_id:string;reason:string}>}
export function reviewPlan(snapshot: PlanningSnapshot, date: string): PlanReview {
  const empty={reasons:{},unscheduled:[]};
  const raw=snapshot.settings[`plan:${date}`];
  if (!raw) return {state:'missing',message:'No saved plan for this day. Capture or review your tasks, then choose Auto-plan.',...empty};
  try {
    if(raw.length>2_000_000) throw new Error('oversized plan');
    const saved=JSON.parse(raw);
    if (!Array.isArray(saved.blocks) || !Array.isArray(saved.unscheduled)) throw new Error('invalid plan');
    const ids=new Set<string>();
    for (const b of saved.blocks) {
      if(typeof b.task_id!=='string' || ids.has(b.task_id) || typeof b.reason!=='string' || b.reason.length>2000 || !Number.isInteger(b.start_min) || !Number.isInteger(b.end_min) || b.start_min<0 || b.end_min>1440 || b.end_min<=b.start_min) throw new Error('invalid block');
      ids.add(b.task_id);
    }
    for(const u of saved.unscheduled) if(typeof u.task_id!=='string' || typeof u.reason!=='string' || u.reason.length>2000) throw new Error('invalid overflow');
    const current=typeof saved.inputs==='string' && saved.inputs===planInputKey(snapshot);
    return {state:current?'current':'stale',message:current?'Saved plan matches your current tasks, calendar and working hours.':'Review needed: tasks or availability changed, or this saved plan predates freshness checks. Choose Auto-plan to refresh.',reasons:Object.fromEntries(saved.blocks.map((b:{task_id:string;reason:string})=>[b.task_id,b.reason])),unscheduled:saved.unscheduled};
  } catch {
    return {state:'invalid',message:'Saved plan details could not be read. Your tasks are preserved. Choose Auto-plan to create new explanations.',...empty};
  }
}
