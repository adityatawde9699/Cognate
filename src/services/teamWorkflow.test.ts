import {beforeEach,it,expect,vi} from 'vitest';
import {createProject,createTask,createCalendarEvent,getLocalDateString,loadOps,updateTask} from '../db';
import {createShare,joinShare,syncShare,grantRole,publishMyAvailability,planTeamForShare,applyTeamAssignments,setAssignee,getRoster,removeMember} from './shareService';
import {publicIdentity,_resetForTests as resetIdentity} from './identity';
import {_resetForTests as resetClock} from './oplogStore';
import {projectAssignees} from './collabProjection';
import {FakeBatchRelay} from './fixtures/fakeBatchRelay';
class Storage {
 data=new Map<string,string>();
 getItem(key:string){return this.data.get(key) ?? null;}
 setItem(key:string,value:string){this.data.set(key,String(value));}
 removeItem(key:string){this.data.delete(key);}
}
let A:Storage,B:Storage;
async function as<T>(storage:Storage,fn:()=>Promise<T>):Promise<T>{vi.stubGlobal('localStorage',storage);resetClock();resetIdentity();return fn();}
beforeEach(()=>{A=new Storage();B=new Storage();const relay=new FakeBatchRelay();vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>relay.handle(init?.method ?? 'GET',url,typeof init?.body === 'string' ? init.body : undefined) as Response));});
async function setup(){return as(A,async()=>{
 const p=await createProject('Team','green');
 const tasks=[];
 for (const title of ['First','Second']) tasks.push(await createTask({title,description:'',deadline:'',tags:[],importance:3,effort:3,project_id:p.id}));
 const shared=await createShare(p.id,'Team','https://relay.example');
 return {...shared,tasks,projectId:p.id};
});}
it('requires opt-in availability and shares interval minutes without calendar titles',async()=>{
 const {share,tasks}=await setup();const date=getLocalDateString();
 await as(A,async()=>{
  const unknown=await planTeamForShare(share.id,date);expect(unknown.assignments).toEqual([]);expect(unknown.unroutable).toEqual(tasks.map(t=>t.id));expect(unknown.unavailable[0].reason).toContain('not shared');
  await createCalendarEvent({title:'SECRET MEDICAL VISIT',start:date+'T09:00:00',end:date+'T10:00:00',source:'manual'});
  await publishMyAvailability(share.id,date);
  const member=(await getRoster(share.id))[0];expect(JSON.stringify(member.availability)).not.toContain('SECRET');expect(member.availability?.busy).toEqual([{start_min:540,end_min:600}]);
  const plan=await planTeamForShare(share.id,date);expect(plan.assignments).toHaveLength(2);await applyTeamAssignments(share.id,plan);
  expect([...projectAssignees(await loadOps()).keys()].sort()).toEqual(tasks.map(t=>t.id).sort());
 });
});
it('writes every reviewed assignment together and preserves all of them if storage fails',async()=>{
 const {share}=await setup();await as(A,async()=>{
  await publishMyAvailability(share.id,getLocalDateString());const plan=await planTeamForShare(share.id,getLocalDateString());const before=await loadOps();
  const original=A.setItem.bind(A);const failure=vi.spyOn(A,'setItem').mockImplementation((key,value)=>{if(key==='cn_atomic_workspace_v1')throw new Error('quota');original(key,value);});
  try{await expect(applyTeamAssignments(share.id,plan)).rejects.toThrow('quota');expect(await loadOps()).toEqual(before);}finally{failure.mockRestore();}
  await applyTeamAssignments(share.id,plan);expect(projectAssignees(await loadOps()).size).toBe(2);
 });
});
it('rejects stale task/availability proposals and manual cross-project assignments',async()=>{
 const {share,tasks}=await setup();await as(A,async()=>{
  await publishMyAvailability(share.id,getLocalDateString());const plan=await planTeamForShare(share.id,getLocalDateString());
  await updateTask(tasks[0].id,{...tasks[0],title:'Changed after preview'});
  const before=await loadOps();await expect(applyTeamAssignments(share.id,plan)).rejects.toThrow('changed');expect(await loadOps()).toEqual(before);
  const outside=await createTask({title:'Private',description:'',deadline:'',tags:[],importance:3,effort:3});
  await expect(setAssignee(share.id,outside.id,(await publicIdentity()).actor)).rejects.toThrow('outside');
 });
});
it('enforces viewer/editor and revoked-device assignment journeys over signed sync',async()=>{
 const {share,invite}=await setup();let b:{actor:string;pub:string};
 await as(A,()=>syncShare(share.id));
 await as(B,async()=>{await joinShare(invite);await syncShare(share.id);b=await publicIdentity();await expect(planTeamForShare(share.id,getLocalDateString())).rejects.toThrow('owner or editor');});
 await as(A,async()=>{await grantRole(share.id,b!.actor,'editor');await syncShare(share.id);});
 await as(B,async()=>{await syncShare(share.id);await publishMyAvailability(share.id,getLocalDateString());const plan=await planTeamForShare(share.id,getLocalDateString());expect(plan.assignments.every(a=>a.actor===b!.actor)).toBe(true);await applyTeamAssignments(share.id,plan);});
 await as(A,async()=>{await syncShare(share.id);await removeMember(share.id,b!.actor);});
 await as(B,async()=>{await syncShare(share.id).catch(()=>{});await expect(planTeamForShare(share.id,getLocalDateString())).rejects.toThrow(/revoked|rotated|owner or editor/);});
});

it('rejects caller-edited proposal dates and assignments',async()=>{
 const {share}=await setup();await as(A,async()=>{
  const date=getLocalDateString();await publishMyAvailability(share.id,date);
  const plan=await planTeamForShare(share.id,date);plan.assignments[0].actor='outsider';
  await expect(applyTeamAssignments(share.id,plan)).rejects.toThrow('expired or changed');
  const fresh=await planTeamForShare(share.id,date);fresh.date='2026-01-01';
  await expect(applyTeamAssignments(share.id,fresh)).rejects.toThrow('expired or changed');
  expect(projectAssignees(await loadOps()).size).toBe(0);
 });
});
