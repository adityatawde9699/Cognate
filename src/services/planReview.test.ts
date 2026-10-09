import { describe,it,expect } from 'vitest';
import {planInputKey,reviewPlan} from './planReview';
import type {PlanningSnapshot} from '../db';
import type {Task} from '../store';
const task={id:'a',title:'Write report',done:false,importance:3,priority:'medium',deadline:'',duration_min:30,pinned:false,scheduled_start:null,scheduled_end:null} as Task;
const snapshot=():PlanningSnapshot=>({tasks:[{...task}],calendar:[],settings:{}});
const result={blocks:[{task_id:'a',start_min:540,end_min:570,reason:'Priority slot'}],unscheduled:[]};
function planned() {
 const before=snapshot(), after=snapshot();
 after.tasks[0].scheduled_start='2026-10-09T09:00:00';after.tasks[0].scheduled_end='2026-10-09T09:30:00';
 after.settings['plan:2026-10-09']=JSON.stringify({...result,inputs:planInputKey(before,'2026-10-09',result)});
 return after;
}
describe('saved plan review',()=>{
 it('keeps explanations and proves freshness after schedule projection and restart',()=>{
  const review=reviewPlan(JSON.parse(JSON.stringify(planned())),'2026-10-09');
  expect(review.state).toBe('current');expect(review.reasons.a).toBe('Priority slot');
 });
 it('detects task edits, captures, calendars, and working-hour changes',()=>{
  const edits=[(s:PlanningSnapshot)=>{s.tasks[0].duration_min=60;},(s:PlanningSnapshot)=>{s.tasks.push({...task,id:'b'});},(s:PlanningSnapshot)=>{s.settings.work_start_min='600';},(s:PlanningSnapshot)=>{s.calendar.push({id:'meeting',title:'Meeting',start:'2026-10-09T09:00:00',end:'2026-10-09T10:00:00',source:'manual',created_at:''});}];
  for(const edit of edits){const s=planned();edit(s);expect(reviewPlan(s,'2026-10-09').state).toBe('stale');}
 });
 it('does not invalidate plans for unrelated saved-day metadata or row ordering',()=>{
  const s=planned();const key=planInputKey(s);s.settings['plan:2026-10-10']='other';expect(planInputKey(s)).toBe(key);
 });
 it('treats legacy explanations as requiring review and malformed records as invalid',()=>{
  const s=planned();s.settings['plan:2026-10-09']=JSON.stringify(result);expect(reviewPlan(s,'2026-10-09').state).toBe('stale');
  s.settings['plan:2026-10-09']='{"blocks":[{}],"unscheduled":[]}';expect(reviewPlan(s,'2026-10-09').state).toBe('invalid');
  expect(reviewPlan(s,'2026-10-10').state).toBe('missing');
 });
 it('accounts for atomic reschedule pin and duration changes in the saved inputs',()=>{
  const s=snapshot(), moved={...result,pin:{task_id:'a',duration_min:30}};
  const projected=planned();projected.tasks[0].pinned=true;
  expect(planInputKey(s,'2026-10-09',moved)).toBe(planInputKey(projected));
 });
});
