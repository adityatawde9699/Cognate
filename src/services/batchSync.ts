/** Durable, immutable sync batches. The operation log itself is the outbox:
 * unacknowledged local operations are never removed when a request fails. */
import { getSetting, setSetting,loadOps } from '../db';
import { canonicalJson, validateOps, type Op } from './oplog';
import { getIdentity } from './identity';
import { importPublicKey, signBytes, verifyBytes, seal, open, type SealedBlob } from './crypto';
import { httpGet, httpPut } from './relayTransport';

export interface BatchContext { kind: 'workspace' | 'share'; id: string; epoch: number }
export interface SignedBatch {
  v: 2; id: string; context: BatchContext; actor: string; pub: string; ops: Op[]; sig: string;
}
interface Pending { id: string; body: string; ops: string[] }
interface Journal { acknowledged: string[]; cursor: number; pending?: Pending; archive: SignedBatch[]; bindings: Record<string,string>; lastSuccess?: string; lastError?: string; attempts: number; failures?:number;retryAt?:number }
const canonical=(value:unknown)=>canonicalJson(value as never);
const bytes=(value: unknown)=>new TextEncoder().encode(canonical(value));
export const syncJournalKey=(url:string,room:string)=>`sync_journal_v2:${encodeURIComponent(url.replace(/\/$/,''))}:${room}`;
const journalScope=(url:string,room:string)=>`${encodeURIComponent(url.replace(/\/$/,''))}:${room}`;
const journalKey=(scope:string)=>`sync_journal_v2:${scope}`;
const locks=new Map<string,Promise<unknown>>();
export async function withSyncLock<T>(room:string, work:()=>Promise<T>): Promise<T> {
  if (typeof navigator!=='undefined' && navigator.locks) return navigator.locks.request(`cognate-sync:${room}`,work);
  const before=locks.get(room) ?? Promise.resolve();
  const next=before.catch(()=>{}).then(work); locks.set(room,next);
  try {return await next;} finally {if(locks.get(room)===next) locks.delete(room);}
}
async function load(room:string):Promise<Journal> {
  const raw=await getSetting(journalKey(room),'');
  return raw ? JSON.parse(raw) : {acknowledged:[],cursor:0,archive:[],bindings:{},attempts:0};
}
async function save(room:string,state:Journal) {await setSetting(journalKey(room),JSON.stringify(state));}
export async function syncDiagnostics(room:string,url:string) {
  const state=await load(journalScope(url,room));
  const identity=await getIdentity(),acknowledged=new Set(state.acknowledged);
  const queued=(await loadOps()).filter(op=>op.hlc.actor===identity.actor && !acknowledged.has(op.id)).length;
  return {cursor:state.cursor,pending:queued,retryAt:state.retryAt,acknowledged:state.acknowledged.length,lastSuccess:state.lastSuccess,lastError:state.lastError,attempts:state.attempts};
}
export async function signBatch(context:BatchContext,ops:Op[]):Promise<SignedBatch> {
  validateOps(ops);
  const identity=await getIdentity();
  if (ops.some(op=>op.hlc.actor!==identity.actor)) throw new Error('Cannot sign another device’s operations.');
  const batch={v:2 as const,id:crypto.randomUUID(),context,actor:identity.actor,pub:identity.pub,ops};
  return {...batch,sig:await signBytes(identity.privateKey,bytes(batch))};
}
export async function verifyBatch(batch:SignedBatch,context:BatchContext):Promise<void> {
  if (!batch || batch.v!==2 || !batch.id || canonical(batch.context)!==canonical(context) || !batch.actor || !batch.pub || !batch.sig) throw new Error('Invalid sync batch context.');
  validateOps(batch.ops);
  if(batch.ops.some(op=>op.hlc.wall>Date.now()+5*60*1000)) throw new Error('Remote device clock is more than five minutes ahead. Correct its clock before syncing.');
  if (batch.ops.length>200 || batch.ops.some(op=>op.hlc.actor!==batch.actor)) throw new Error('Invalid batch author or size.');
  const {sig,...payload}=batch;
  if (!await verifyBytes(await importPublicKey(batch.pub),sig,bytes(payload))) throw new Error('Invalid sync batch signature.');
}
export interface BatchSession {url:string;room:string;key:CryptoKey;context:BatchContext;trustedBindings?:Record<string,string>}
/** Preparation precedes HTTP. Lost acknowledgements retry the exact ciphertext
 * and batch ID; server rejects a collision instead of overwriting history. */
export async function pushBatches(session:BatchSession,ops:Op[]):Promise<number> {
  const scope=journalScope(session.url,session.room);
  const state=await load(scope), me=await getIdentity();
  let pushed=0;
  try {
    for (let round=0;round<10;round++) {
      if (!state.pending) {
        const acknowledged=new Set(state.acknowledged);
        const delta=ops.filter(op=>op.hlc.actor===me.actor && !acknowledged.has(op.id)).slice(0,200);
        if (!delta.length) break;
        const batch=await signBatch(session.context,delta);
        const body=JSON.stringify(await seal(session.key,batch));
        if(new TextEncoder().encode(body).length>1_000_000) throw new Error('Sync batch exceeds relay size limit.');
        state.pending={id:batch.id,body,ops:delta.map(op=>op.id)};
        await save(scope,state);
      }
      state.attempts++;
      const pending=state.pending;
      const reply=JSON.parse(await httpPut(`${session.url}/v2/rooms/${session.room}/batches/${pending.id}`,pending.body));
      if (reply.batch_id!==pending.id || reply.durable!==true || !Number.isSafeInteger(reply.cursor) || reply.cursor<=0) throw new Error('Relay did not acknowledge durable batch storage. Upgrade the relay.');
      state.acknowledged=[...new Set([...state.acknowledged,...pending.ops])];
      pushed+=pending.ops.length; delete state.pending; delete state.lastError;state.failures=0;delete state.retryAt;
      await save(scope,state);
    }
    return pushed;
  } catch(error) {state.lastError=error instanceof Error?error.message:String(error);state.failures=(state.failures ?? 0)+1;state.retryAt=Date.now()+Math.min(300000,1000*2**Math.min(state.failures,9));await save(scope,state);throw error;}
}
/** Commit projection before advancing the cursor. A crash in between replays
 * idempotently; malformed/decryption/authorization failures never skip data. */
export async function pullBatches<T>(session:BatchSession,admit:(archive:SignedBatch[])=>Promise<T>):Promise<{batches:number;result:T}> {
  const scope=journalScope(session.url,session.room);
  const state=await load(scope);
  let count=0;
  let result: T;
  try {
    for (let pageNumber=0;pageNumber<50;pageNumber++) {
      const page=JSON.parse(await httpGet(`${session.url}/v2/rooms/${session.room}/batches?after=${state.cursor}`));
      if (!Array.isArray(page.batches) || page.batches.length>200 || !Number.isSafeInteger(page.cursor) || page.cursor<state.cursor) throw new Error('Invalid relay cursor response.');
      const identity=await getIdentity();
      const incoming:SignedBatch[]=[]; const bindings={...state.bindings};
      for(const [actor,pub] of Object.entries({...session.trustedBindings,[identity.actor]:identity.pub})) {
        if(bindings[actor] && bindings[actor]!==pub) throw new Error('Stored sync trust does not match the device or share owner.');
        bindings[actor]=pub;
      }
      let cursor=state.cursor;
      for (const record of page.batches as Array<SealedBlob & {batch_id:string;cursor:number}>) {
        if(record.cursor!==cursor+1) throw new Error('Relay batch history has a gap.');
        const batch=await open<SignedBatch>(session.key,record);
        await verifyBatch(batch,session.context);
        if(batch.id!==record.batch_id) throw new Error('Relay batch ID does not match signed data.');
        if(bindings[batch.actor] && bindings[batch.actor]!==batch.pub) throw new Error('Sync actor key changed. Recover or explicitly replace the device identity.');
        bindings[batch.actor]=batch.pub; incoming.push(batch);cursor=record.cursor;
      }
      if(cursor!==page.cursor) throw new Error('Relay cursor skipped history.');
      const archive=[...state.archive,...incoming];
      result=await admit(archive);
      state.archive=archive;state.bindings=bindings;state.cursor=cursor;state.lastSuccess=new Date().toISOString();delete state.lastError;state.failures=0;delete state.retryAt;
      await save(scope,state);count+=incoming.length;
      if(!incoming.length) break;
    }
    return {batches:count,result:result!};
  } catch(error) {state.lastError=error instanceof Error?error.message:String(error);state.failures=(state.failures ?? 0)+1;state.retryAt=Date.now()+Math.min(300000,1000*2**Math.min(state.failures,9));await save(scope,state);throw error;}
}

export async function checkRetryWindow(room:string,url:string):Promise<void> {
  const state=await load(journalScope(url,room));
  if(state.retryAt && state.retryAt>Date.now()) throw new Error(`Sync is backing off after an error. Next automatic retry after ${new Date(state.retryAt).toISOString()}.`);
}
