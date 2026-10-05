import {beforeEach,describe,it,expect,vi} from 'vitest';
import {FakeBatchRelay,DeviceStorage} from './fixtures/fakeBatchRelay';
import {enableSync,syncNow,disableSync} from './relayService';
import {logCollabSet,_resetForTests as resetClock} from './oplogStore';
import {_resetForTests as resetIdentity,getIdentity} from './identity';
import {loadOps,getSetting} from '../db';
import {deriveRoomId,seal,deriveSyncKey} from './crypto';
import {signBatch,verifyBatch,syncDiagnostics,syncJournalKey,pushBatches} from './batchSync';
import {Clock,setOp} from './oplog';
vi.mock('./syncService',()=>({mergeIntoApp:vi.fn(async ops=>({applied:await (await import('./oplogStore')).ingestOps(ops),upserts:0,deletes:0}))}));
const pass='batch-test-strong-passphrase',url='https://relay.example';
async function on<T>(store:DeviceStorage,fn:()=>Promise<T>) {
  Object.assign(globalThis,{localStorage:store});resetClock();resetIdentity();await enableSync(url,pass);return fn();
}
describe('immutable authenticated batch sync',()=>{
  let relay:FakeBatchRelay,A:DeviceStorage,B:DeviceStorage,C:DeviceStorage;
  beforeEach(()=>{relay=new FakeBatchRelay();A=new DeviceStorage();B=new DeviceStorage();C=new DeviceStorage();vi.stubGlobal('fetch',vi.fn(async(url,init)=>relay.handle(init?.method ?? 'GET',url,init?.body)));});
  it('three independent devices converge across an outage without republishing remote authors',async()=>{
    await on(A,async()=>{await logCollabSet('task-a','title','A');relay.failBefore=true;await expect(syncNow()).rejects.toThrow('503');});
    relay.failBefore=false;
    await on(B,async()=>{await logCollabSet('task-b','title','B');await syncNow();});
    await on(C,async()=>{await logCollabSet('task-c','title','C');await syncNow();});
    await on(A,async()=>{await syncNow();expect((await loadOps()).map(op=>op.entity).sort()).toEqual(['task-a','task-b','task-c']);});
    await on(B,async()=>{await syncNow();expect(await loadOps()).toHaveLength(3);});
    await on(C,async()=>{await syncNow();expect(await loadOps()).toHaveLength(3);expect((await syncNow()).pushed).toBe(0);});
    expect([...relay.rooms.values()][0].size).toBe(3);
  });
  it('retries identical ciphertext after a lost acknowledgement and after restart',async()=>{
    await on(A,async()=>{await logCollabSet('a','title','saved');relay.loseAcknowledgement=true;await expect(syncNow()).rejects.toThrow('connection lost');});
    await on(A,async()=>{await syncNow();expect((await syncNow()).pushed).toBe(0);});
    expect(relay.uploads[0]).toBe(relay.uploads[1]);expect([...relay.rooms.values()][0].size).toBe(1);
  });
  it('never advances a cursor or imports data when ciphertext is corrupted',async()=>{
    await on(A,async()=>{await logCollabSet('a','title','secret');await syncNow();});
    const record=[...relay.rooms.values()][0].values().next().value;record.ct='corrupted';
    await on(B,async()=>{await expect(syncNow()).rejects.toThrow('Decryption');expect(await loadOps()).toHaveLength(0);expect((await syncDiagnostics(await deriveRoomId(pass),url)).cursor).toBe(0);});
  });
  it('binds signatures to context/epoch and cannot sign a foreign author',async()=>{
    await on(A,async()=>{
      const id=await getIdentity(),op=setOp(new Clock(id.actor),'task','title','value');
      if(op.kind!=='set') throw new Error('Expected set');
      const context={kind:'share' as const,id:'share-a',epoch:1},batch=await signBatch(context,[op]);
      await verifyBatch(batch,context);
      await expect(verifyBatch(batch,{...context,id:'share-b'})).rejects.toThrow('context');
      await expect(verifyBatch(batch,{...context,epoch:2})).rejects.toThrow('context');
      await expect(verifyBatch({...batch,ops:[{...op,value:'tampered'}]},context)).rejects.toThrow('signature');
      await expect(signBatch(context,[{...op,hlc:{...op.hlc,actor:'foreign'}}])).rejects.toThrow('another device');
    });
  });
  it('rejects a valid encrypted payload with a mismatched signed batch ID',async()=>{
    await on(A,async()=>{
      const room=await deriveRoomId(pass),identity=await getIdentity();
      const batch=await signBatch({kind:'workspace',id:room,epoch:1},[setOp(new Clock(identity.actor),'task','title','x')]);
      relay.rooms.set(room,new Map([['wrong',{...await seal(await deriveSyncKey(pass),batch),batch_id:'wrong',cursor:1}]]));
      await expect(syncNow()).rejects.toThrow('batch ID');
      expect(JSON.parse(await getSetting(syncJournalKey(url,room),'{}')).cursor).toBe(0);
    });
  });
  it('keeps acknowledgements separate for independent relay endpoints',async()=>{
    const second=new FakeBatchRelay();
    vi.stubGlobal('fetch',vi.fn(async(request,init)=>(String(request).startsWith('https://second.example')?second:relay).handle(init?.method ?? 'GET',request,init?.body)));
    await on(A,async()=>{
      await logCollabSet('task','title','endpoint test');const room=await deriveRoomId(pass),key=await deriveSyncKey(pass);
      const context={kind:'workspace' as const,id:room,epoch:1};
      expect(await pushBatches({url,room,key,context},await loadOps())).toBe(1);
      expect(await pushBatches({url:'https://second.example',room,key,context},await loadOps())).toBe(1);
      expect([...second.rooms.values()][0].size).toBe(1);
    });
  });
  it('does not silently rekey history by disabling and reconnecting elsewhere',async()=>{
    await on(A,async()=>{
      await logCollabSet('task','title','retained');
      await expect(enableSync('https://second.example',pass)).rejects.toThrow('explicit migration');
      await disableSync();
      await expect(enableSync(url,'new-workspace-passphrase')).rejects.toThrow('previous sync configuration');
      expect(await loadOps()).toHaveLength(1);
      await enableSync(url,pass);
    });
  });

});
