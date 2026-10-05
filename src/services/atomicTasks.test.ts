import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTask, updateTask, deleteTask, getAllTasks, loadOps, toggleTask, addPomodoro, updateSortOrders, setSchedule } from '../db';
import { projectTasks } from './projector';
import { taskRecord } from './taskFields';

class Storage {
  data = new Map<string,string>();
  getItem(key:string) { return this.data.get(key) ?? null; }
  setItem(key:string,value:string) { this.data.set(key,value); }
}
const input = {title:'Durable task',description:'',deadline:'',tags:[],importance:3,effort:3};
beforeEach(() => { vi.stubGlobal('localStorage', new Storage()); });

describe('atomic task projection and operation commits', () => {
  it('leaves both layers unchanged when storage quota rejects an edit', async () => {
    const task = await createTask(input);
    const beforeTasks = await getAllTasks('all');
    const beforeOps = await loadOps();
    vi.spyOn(localStorage,'setItem').mockImplementation(() => { throw new Error('quota exceeded'); });
    await expect(updateTask(task.id,{...input,title:'Lost edit'})).rejects.toThrow('quota exceeded');
    expect(await getAllTasks('all')).toEqual(beforeTasks);
    expect(await loadOps()).toEqual(beforeOps);
  });
  it('replay matches create, completion, focus count, reorder, schedule, and deletion immediately', async () => {
    const a = await createTask(input);
    const b = await createTask({...input,title:'Second'});
    await toggleTask(a.id);
    await addPomodoro(a.id);
    await updateSortOrders([b.id,a.id]);
    await setSchedule(b.id,'2026-10-06T10:00:00','2026-10-06T11:00:00');
    const rows = (await getAllTasks('all')).sort((a,b)=>a.id.localeCompare(b.id));
    const replay = projectTasks(await loadOps()).sort((a,b)=>a.id.localeCompare(b.id));
    expect(replay.map(taskRecord)).toEqual(rows.map(taskRecord));
    expect(rows.find(t=>t.id===a.id)?.completed_at).toBeTruthy();
    expect(rows.find(t=>t.id===a.id)?.pomodoros_spent).toBe(1);
    await deleteTask(a.id);
    expect(projectTasks(await loadOps()).map(t=>t.id)).toEqual([b.id]);
  });
  it('preserves legacy records when migration or first command fails', async () => {
    localStorage.setItem('cn_tasks_v2',JSON.stringify([{id:'legacy',...input}]));
    const raw = localStorage.getItem('cn_tasks_v2');
    vi.spyOn(localStorage,'setItem').mockImplementation(() => { throw new Error('disk full'); });
    await expect(createTask(input)).rejects.toThrow('disk full');
    expect(localStorage.getItem('cn_tasks_v2')).toBe(raw);
    expect(localStorage.getItem('cn_atomic_workspace_v1')).toBeNull();
    expect(await getAllTasks('all')).toHaveLength(1);
  });
});

import { createProject, deleteProject, getProjects } from '../db';
import { materialize } from './oplog';

it('project deletion and task detachment commit together and replay', async () => {
  const project = await createProject('Project');
  const task = await createTask({...input,project_id:project.id});
  const before = localStorage.getItem('cn_atomic_workspace_v1');
  const write = vi.spyOn(localStorage,'setItem').mockImplementationOnce(()=>{throw new Error('quota');});
  await expect(deleteProject(project.id)).rejects.toThrow('quota');
  expect(localStorage.getItem('cn_atomic_workspace_v1')).toBe(before);
  write.mockRestore();
  await deleteProject(project.id);
  expect(await getProjects()).toEqual([]);
  const state = materialize(await loadOps());
  expect(state.has(`project:${project.id}`)).toBe(false);
  expect(state.get(task.id)?.project_id).toBeNull();
});

it('recurrence is atomic and idempotent across complete/undo/complete', async () => {
  const task = await createTask({...input,deadline:'2026-01-31',recurrence:'monthly'});
  await toggleTask(task.id);
  let tasks = await getAllTasks('all');
  expect(tasks).toHaveLength(2);
  expect(tasks.find(t=>t.id!==task.id)?.deadline).toBe('2026-02-28');
  await toggleTask(task.id); await toggleTask(task.id);
  tasks = await getAllTasks('all');
  expect(tasks).toHaveLength(2);
  expect(projectTasks(await loadOps()).map(t=>t.id).sort()).toEqual(tasks.map(t=>t.id).sort());
});
