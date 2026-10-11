import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTask, updateTask, getAllTasks, loadOps, getPlanningSnapshot, commitPlan, createCalendarEvent } from '../db';
import * as db from '../db';
import { planDay, PlanRefreshError } from './planService';
import { useStore } from '../store';
import { projectTasks } from './projector';
import { taskRecord } from './taskFields';
import { applySchedulingEstimates } from '../db';
class Storage {
  data = new Map<string,string>();
  getItem(key:string) { return this.data.get(key) ?? null; }
  setItem(key:string,value:string) { this.data.set(key,value); }
}
const input = {title:'Planned task',description:'',deadline:'',tags:[],importance:3,effort:3};
const provenance = {provider:'ollama',model:'test',local:true,estimated_at:'2026-10-11T00:00:00Z'};
beforeEach(() => {vi.stubGlobal('localStorage',new Storage());useStore.getState().setTasks([]);useStore.getState().setFilter('all');});
describe('atomic planning', () => {
  it('commits estimates and provenance together, with replay parity',async()=>{
    const a=await createTask(input), b=await createTask({...input,title:'Second'});
    await applySchedulingEstimates([a,b].map(t=>({id:t.id,duration_min:45,energy:'hi',provenance})),await getPlanningSnapshot());
    const rows=await getAllTasks('all');
    expect(rows.every(t=>t.duration_min===45 && JSON.parse(t.custom_fields._cognate_estimate).model==='test')).toBe(true);
    expect(projectTasks(await loadOps()).map(taskRecord)).toEqual(rows.map(taskRecord));
  });
  it('rejects stale advice and quota failures without applying any estimates',async()=>{
    const a=await createTask(input), b=await createTask({...input,title:'Second'});
    const estimates=[a,b].map(t=>({id:t.id,duration_min:45,energy:'hi' as const,provenance}));
    const expected=await getPlanningSnapshot();
    await updateTask(b.id,{...input,title:'Concurrent edit'});
    await expect(applySchedulingEstimates(estimates,expected)).rejects.toThrow('changed');
    const fresh=await getPlanningSnapshot(), before=localStorage.getItem('cn_atomic_workspace_v1');
    vi.spyOn(localStorage,'setItem').mockImplementationOnce(()=>{throw new Error('quota');});
    await expect(applySchedulingEstimates(estimates,fresh)).rejects.toThrow('quota');
    expect(localStorage.getItem('cn_atomic_workspace_v1')).toBe(before);
  });
  it('plans the durable workspace even when the visible filter is empty', async () => {
    const task = await createTask(input);
    const result = await planDay('2026-10-06');
    expect(result.blocks.map(b=>b.task_id)).toContain(task.id);
    const rows = await getAllTasks('all');
    expect(rows[0].scheduled_start).toBeTruthy();
    expect(projectTasks(await loadOps()).map(taskRecord)).toEqual(rows.map(taskRecord));
  });
  it('keeps the entire previous plan and history if saving fails', async () => {
    const task = await createTask(input);
    const expected = await getPlanningSnapshot();
    const before = localStorage.getItem('cn_atomic_workspace_v1');
    vi.spyOn(localStorage,'setItem').mockImplementationOnce(()=>{throw new Error('quota');});
    await expect(commitPlan('2026-10-06',{blocks:[{task_id:task.id,start_min:600,end_min:660,reason:'Slot'}],unscheduled:[]},expected)).rejects.toThrow('quota');
    expect(localStorage.getItem('cn_atomic_workspace_v1')).toBe(before);
  });
  it('rejects a stale solve after a task edit', async () => {
    const task = await createTask(input);
    const expected = await getPlanningSnapshot();
    await updateTask(task.id,{...input,title:'Concurrent edit'});
    const before = localStorage.getItem('cn_atomic_workspace_v1');
    await expect(commitPlan('2026-10-06',{blocks:[],unscheduled:[]},expected)).rejects.toThrow('changed');
    expect(localStorage.getItem('cn_atomic_workspace_v1')).toBe(before);
  });
  it('rejects a stale solve when a meeting arrives', async () => {
    await createTask(input);
    const expected = await getPlanningSnapshot();
    await createCalendarEvent({title:'New meeting',start:'2026-10-06T09:00:00',end:'2026-10-06T10:00:00'});
    await expect(commitPlan('2026-10-06',{blocks:[],unscheduled:[]},expected)).rejects.toThrow('changed');
  });
});

it('rejects a drag into busy time without changing the task, pin, or history',async()=>{
  const task=await createTask(input);
  await createCalendarEvent({title:'Busy',start:'2026-10-06T09:00:00',end:'2026-10-06T10:00:00'});
  const before=localStorage.getItem('cn_atomic_workspace_v1');
  await expect(planDay('2026-10-06',{pin:{taskId:task.id,startMin:540,durationMin:30}})).rejects.toThrow('conflicts');
  expect(localStorage.getItem('cn_atomic_workspace_v1')).toBe(before);
});
it('commits a valid drag, pin, and reflowed history as one workspace change',async()=>{
  const task=await createTask(input);
  const result=await planDay('2026-10-06',{pin:{taskId:task.id,startMin:600,durationMin:30}});
  expect(result.blocks[0]).toMatchObject({task_id:task.id,start_min:600,end_min:630});
  const row=(await getAllTasks('all'))[0];
  expect(row).toMatchObject({pinned:true,duration_min:30,scheduled_start:'2026-10-06T10:00:00'});
  expect(projectTasks(await loadOps()).map(taskRecord)).toEqual([taskRecord(row)]);
});

it('cancellation leaves the prior plan and operation history intact',async()=>{
  await createTask(input);await planDay('2026-10-06');
  const before=localStorage.getItem('cn_atomic_workspace_v1'),controller=new AbortController();controller.abort();
  await expect(planDay('2026-10-06',{signal:controller.signal})).rejects.toThrow('cancelled');
  expect(localStorage.getItem('cn_atomic_workspace_v1')).toBe(before);
});

it('distinguishes a committed plan from a failed UI refresh',async()=>{
  await createTask(input);
  const read=vi.spyOn(db,'getAllTasks').mockRejectedValueOnce(new Error('read unavailable'));
  try {
    await expect(planDay('2026-10-06')).rejects.toBeInstanceOf(PlanRefreshError);
    expect((await getPlanningSnapshot()).tasks[0].scheduled_start).toBeTruthy();
  } finally {read.mockRestore();}
});
