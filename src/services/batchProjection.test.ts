import {beforeEach,it,expect,vi} from 'vitest';
import {DeviceStorage,FakeBatchRelay} from './fixtures/fakeBatchRelay';
import {createTask,updateTask,getAllTasks,loadOps} from '../db';
import {enableSync,syncNow} from './relayService';
import {_resetForTests as resetClock} from './oplogStore';
import {_resetForTests as resetIdentity} from './identity';
import {useStore} from '../store';
const input={title:'Shared durable row',description:'',deadline:'',tags:[],importance:3,effort:3};
let relay:FakeBatchRelay;
beforeEach(()=>{relay=new FakeBatchRelay();vi.stubGlobal('fetch',vi.fn(async(url,init)=>relay.handle(init?.method ?? 'GET',url,init?.body)));});
async function on<T>(storage:DeviceStorage,work:()=>Promise<T>) {vi.stubGlobal('localStorage',storage);resetClock();resetIdentity();useStore.getState().setTasks([]);await enableSync('https://relay.example','independent-stores-passphrase');return work();}
it('three actual row/history stores converge after duplicate delivery, offline editing and reconnect',async()=>{
  const A=new DeviceStorage(),B=new DeviceStorage(),C=new DeviceStorage();let id='';
  await on(A,async()=>{id=(await createTask(input)).id;relay.loseAcknowledgement=true;await expect(syncNow()).rejects.toThrow('connection lost');});
  await on(A,async()=>{await syncNow();});
  await on(B,async()=>{await syncNow();expect((await getAllTasks('all'))[0].title).toBe(input.title);await updateTask(id,{...input,title:'Edited while offline'});relay.failBefore=true;await expect(syncNow()).rejects.toThrow('503');});
  relay.failBefore=false;
  await on(C,async()=>{await syncNow();expect((await getAllTasks('all'))[0].title).toBe(input.title);});
  await on(B,async()=>{await syncNow();});
  let expected='';
  for(const storage of [A,C,B]) await on(storage,async()=>{await syncNow();expect((await getAllTasks('all'))[0].title).toBe('Edited while offline');const ops=JSON.stringify((await loadOps()).map(op=>op.id).sort());if(expected)expect(ops).toBe(expected);else expected=ops;});
  expect(relay.uploads[0]).toBe(relay.uploads[1]);
});
