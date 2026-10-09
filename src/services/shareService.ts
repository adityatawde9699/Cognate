/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   src/services/shareService.ts — shared projects over the E2E relay (Act 3)
   ──────────────────────────────────────────────────────
   "Sharing a project = sharing a CRDT doc key." A Share scopes one project to
   its OWN random data key + relay room (crypto.ts), isolated from your
   workspace and every other share. The round-trip is the Act-2 spine, plus
   authenticity & authorization:

     push:  extract this project's ops from the local log → SIGN them with our
            identity → seal under the SHARE key → PUT to the share room.
     pull:  GET the room → decrypt with the share key → VERIFY signatures →
            AUTHORIZE against the share's genesis owner + member roster
            (collab.ts) → ingest only the accepted ops → reconcile to SQLite.

   Security properties that fall out:
     • A relay (or anyone without the share secret) sees only ciphertext.
     • Holding the secret grants READ; WRITE requires a roster role an owner
       granted — unauthorized ops are dropped on every peer, deterministically.
     • Sharing one project never exposes the rest of your workspace: different
       key, different room.

   The share SECRET is a capability — deliver an invite token over a secure
   channel; anyone who gets it can read the project.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

import { IS_TAURI, getSetting, setSetting, loadOps, getPlanningSnapshot, getProjects, upsertProjectRaw } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { canonicalJson, materialize, type Op, type Json } from './oplog';
import { isTaskEntity, entityStateToTask } from './projector';
import { projectActivity, type ActivityEntry } from './activity';
import { getWorkHours, busyBlocksForDate } from './planService';
import { planTeam, toTeamPlanTask, type TeamPlanResult, type TeamAssignment } from './teamPlanService';
import { loadProjects } from './taskService';
import { generateShareSecret, importShareKey, roomIdForSecret,signBytes,verifyBytes,importPublicKey } from './crypto';
import { publicIdentity,getIdentity } from './identity';
import { authorizeVerified, memberActor, type Member, type Role } from './collab';
import { projectComments, projectRoster, projectAssignees, projectSharedProjects, type Comment } from './collabProjection';
import { logCollabSet, logCollabBatch, logCollabDel,logCollabCheckpoint, actorId } from './oplogStore';
import { mergeIntoApp } from './syncService';
import { httpGet } from './relayTransport';

import {availabilityStatus,validAvailability,type TeamAvailability} from './teamAvailability';
import {calendarWarnings,ensureCalendarCoverage} from './calendarSyncService';
import {fingerprint,normalizedTask} from './historyAudit';
import {planInputKey} from './planReview';
import { pushBatches, pullBatches, withSyncLock,checkRetryWindow } from './batchSync';

const METAS_KEY = 'shares_v1';
const secretKey = (id: string) => `share_secret_${id}`;

/** Persisted, NON-secret share metadata. The secret lives in the keychain. */
export interface ShareMeta {
  id: string;
  name: string;
  projectId: string;          // the local project whose tasks this share carries
  url: string;                // relay base url
  role: Role;                 // our last-known role in this share
  genesis: { actor: string; pub: string }; // the trusted owner of the doc
  epoch?: number;
  inviteSig?:string;
}

/** A share with its secret loaded — the form push/pull need. */
export interface Share extends ShareMeta {
  secret: string;
}

/** A portable invite. The `secret` is a capability — share it securely. */
export interface InviteToken {
  v: 2;
  epoch?: number;
  sig?:string;
  id: string;
  name: string;
  projectId: string;
  url: string;
  secret: string;
  genesis: { actor: string; pub: string };
}

// ── Registry persistence ─────────────────────────────────

async function loadMetas(): Promise<ShareMeta[]> {
  const raw = await getSetting(METAS_KEY, '');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ShareMeta[]) : [];
  } catch {
    return [];
  }
}
async function saveMetas(metas: ShareMeta[]): Promise<void> {
  await setSetting(METAS_KEY, JSON.stringify(metas));
}
async function upsertMeta(meta: ShareMeta): Promise<void> {
  const metas = await loadMetas();
  const i = metas.findIndex((m) => m.id === meta.id);
  if (i >= 0) metas[i] = meta;
  else metas.push(meta);
  await saveMetas(metas);
}

export async function listShares(): Promise<ShareMeta[]> {
  return loadMetas();
}

export async function getShare(id: string): Promise<Share | null> {
  const meta = (await loadMetas()).find((m) => m.id === id);
  if (!meta) return null;
  const secret = await getSecret(secretKey(id));
  const rotation=await getSecret(`share_rotation_${id}`);
  if(rotation) {
    const pending=JSON.parse(rotation);
    if(pending.phase==='published' && (meta.epoch ?? 1)<pending.epoch) {
      await setSecret(secretKey(id),pending.secret);
      const recovered={...meta,epoch:pending.epoch,inviteSig:pending.inviteSig};await upsertMeta(recovered);return {...recovered,secret:pending.secret};
    }
  }
  return secret ? { ...meta, secret } : null;
}

export async function removeShare(id: string): Promise<void> {
  await saveMetas((await loadMetas()).filter((m) => m.id !== id));
  await setSecret(secretKey(id), ''); // forget the capability locally
}

/** Restore a share + its secret onto this device (used by recovery import). */
export async function importShareRecord(meta: ShareMeta, secret: string): Promise<void> {
  await setSecret(secretKey(meta.id), secret);
  await upsertMeta(meta);
}

// ── Creating / joining ───────────────────────────────────

const enc = (o: unknown) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
const dec = <T>(s: string): T => JSON.parse(decodeURIComponent(escape(atob(s)))) as T;

async function signInvite(invite:InviteToken):Promise<string> {
  const me=await getIdentity();
  if(me.actor!==invite.genesis.actor || me.pub!==invite.genesis.pub) throw new Error('Only the genesis owner can mint a new signed invite.');
  const {sig:_sig,...payload}=invite;
  return signBytes(me.privateKey,new TextEncoder().encode(canonicalJson(payload as never)));
}

/** Create a share for a project. We become its genesis owner. Returns an
 *  invite token string to hand a teammate over a secure channel. */
export async function createShare(projectId: string, name: string, url?: string): Promise<{ share: Share; invite: string }> {
  const me = await publicIdentity();
  const secret = generateShareSecret();
  const id = crypto.randomUUID();
  const relayUrl = (url ?? (await getSetting('sync_relay_url', '')) ?? '').replace(/\/$/, '');

  const meta: ShareMeta = { id, name, projectId, url: relayUrl, role: 'owner', genesis: { actor: me.actor, pub: me.pub } };
  await setSecret(secretKey(id), secret);
  await upsertMeta(meta);

  // Seed the roster: we are the owner, with our public key bound.
  await logCollabSet(`member:${id}:${me.actor}`, 'pub', me.pub);
  await logCollabSet(`member:${id}:${me.actor}`, 'role', 'owner');
  await publishWorkHours(id, me.actor);

  // Carry the project's identity (name/color) so a joiner sees it named/grouped.
  const proj = (await getProjects()).find((p: any) => p.id === projectId);
  if (proj) {
    await logCollabSet(`project:${projectId}`, 'name', proj.name ?? name);
    await logCollabSet(`project:${projectId}`, 'color', proj.color ?? '');
  }

  const invite: InviteToken = { v: 2, id, name, projectId, url: relayUrl, secret, genesis: meta.genesis };
  invite.epoch=1;
  invite.sig=await signInvite(invite);
  meta.epoch=1;meta.inviteSig=invite.sig;await upsertMeta(meta);
  return { share: { ...meta, secret }, invite: enc(invite) };
}

/** Join a share from an invite token. We start as a viewer; an owner grants a
 *  higher role after seeing the key we publish here. */
export async function joinShare(token: string): Promise<Share> {
  let t: InviteToken;
  try {
    t = dec<InviteToken>(token);
  } catch {
    throw new Error('Invalid invite token.');
  }
  if (t.v !== 2 || !t.id || !t.projectId || !t.secret || !t.genesis?.actor || !t.genesis.pub || !t.sig || !Number.isInteger(t.epoch) || t.epoch!<1) throw new Error('Invalid or legacy invite. Ask the owner for a signed invitation.');
  const {sig,...payload}=t;
  if(!await verifyBytes(await importPublicKey(t.genesis.pub),sig,new TextEncoder().encode(canonicalJson(payload as never)))) throw new Error('Invite signature does not match its owner.');
  const existing=(await loadMetas()).find(meta=>meta.id===t.id);
  if(existing && (existing.genesis.actor!==t.genesis.actor || existing.genesis.pub!==t.genesis.pub || existing.projectId!==t.projectId || (t.epoch ?? 1)<(existing.epoch ?? 1))) throw new Error('Invite attempts to replace share trust or downgrade its epoch.');

  const meta: ShareMeta = { id: t.id, name: t.name, projectId: t.projectId, url: (t.url ?? '').replace(/\/$/, ''), role: 'viewer', genesis: t.genesis, epoch:t.epoch ?? 1,inviteSig:t.sig };
  await setSecret(secretKey(t.id), t.secret);
  await upsertMeta(meta);

  // Announce our public key so the owner can grant us a role (self-claim only).
  const me = await publicIdentity();
  await logCollabSet(`member:${t.id}:${me.actor}`, 'pub', me.pub);
  await publishWorkHours(t.id, me.actor);

  return { ...meta, secret: t.secret };
}

/** Publish our own working hours into a share's roster (self-declared). */
async function publishWorkHours(shareId: string, actor: string): Promise<void> {
  try {
    const { start, end } = await getWorkHours();
    await logCollabSet(`member:${shareId}:${actor}`, 'work_start', start);
    await logCollabSet(`member:${shareId}:${actor}`, 'work_end', end);
  } catch (e) {
    console.warn('[share] could not publish work hours:', e);
  }
}

// ── Roster administration (owner only, enforced cryptographically on peers) ──

/** Grant (or change) a member's role. Only meaningful if WE are an owner —
 *  peers reject the op otherwise (collab.applyAccessControl). */
export async function grantRole(shareId: string, actor: string, role: Role): Promise<void> {
  await logCollabSet(`member:${shareId}:${actor}`, 'role', role);
}

/** Remove a member, revoking their write access for ops after this point. */
export async function removeMember(shareId: string, actor: string): Promise<void> {
  const share=await getShare(shareId),me=await publicIdentity();
  if(!share || me.actor!==share.genesis.actor || me.pub!==share.genesis.pub || actor===me.actor) throw new Error('The genesis owner must revoke another member.');
  await logCollabDel(`member:${shareId}:${actor}`);
  await rotateShareKey(shareId);
}

/** Rotate room/key after revocation. Remaining members receive the new signed
 * invite through a secure external channel; revoked devices see only old data. */
export async function rotateShareKey(shareId:string):Promise<string> {
  const share=await getShare(shareId),me=await publicIdentity();
  if(!share || me.actor!==share.genesis.actor || me.pub!==share.genesis.pub) throw new Error('Only the genesis owner can rotate the read key.');
  return withSyncLock(await roomIdForSecret(share.secret),async()=>{
  const oldOps=await shareOps(share),states=materialize(oldOps);
  const roster=await getRoster(shareId);
  for(const member of roster) if(member.actor!==me.actor) {
    states.set(`member:${shareId}:${member.actor}`,{pub:member.pub,role:member.role,...(member.work_start_min!==undefined?{work_start:member.work_start_min}:{}),...(member.work_end_min!==undefined?{work_end:member.work_end_min}:{})});
  }
  const removed=[...new Set(oldOps.filter(op=>op.kind==='del' && !states.has(op.entity)).map(op=>op.entity))];
  const retained=await getSecret(`share_rotation_${share.id}`),pending=retained?JSON.parse(retained):null;
  const secret=pending?.phase==='prepared'?pending.secret:generateShareSecret(),epoch=pending?.phase==='prepared'?pending.epoch:(share.epoch ?? 1)+1;
  const invite:InviteToken={v:2,id:share.id,name:share.name,projectId:share.projectId,url:share.url,secret,genesis:share.genesis,epoch};
  invite.sig=await signInvite(invite);
  const record={oldSecret:share.secret,secret,epoch,inviteSig:invite.sig,phase:'prepared'};
  await setSecret(`share_rotation_${share.id}`,JSON.stringify(record));
  await logCollabCheckpoint(states,removed);
  await logCollabSet(`member:${shareId}:${me.actor}`,'read_epoch',epoch);
  // Publish the signed freeze in the old room before exposing the new key.
  await pushShareUnlocked(share);
  await setSecret(`share_rotation_${share.id}`,JSON.stringify({...record,phase:'published'}));
  await setSecret(secretKey(share.id),secret);
  const {secret:_old,...meta}=share;
  await upsertMeta({...meta,epoch,inviteSig:invite.sig});
  return enc(invite);
  });
}

/** Re-derive the shareable invite token for an existing share (to copy again). */
export async function inviteFor(shareId: string): Promise<string> {
  const share = await getShare(shareId);
  if (!share) throw new Error('Unknown share.');
  const invite: InviteToken = {
    v: 2,
    id: share.id,
    name: share.name,
    projectId: share.projectId,
    url: share.url,
    secret: share.secret,
    genesis: share.genesis,
    epoch:share.epoch ?? 1,
  };
  invite.sig=share.inviteSig || await signInvite(invite);
  return enc(invite);
}

// ── Comments, assignees, roster (collaboration content) ──

/** Post a comment on a task within a share, then push best-effort. */
export async function addComment(shareId: string, taskId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text) return;
  const me = await actorId();
  const entity = `comment:${shareId}:${crypto.randomUUID()}`;
  await logCollabSet(entity, 'task_id', taskId);
  await logCollabSet(entity, 'author', me);
  await logCollabSet(entity, 'body', text);
  await logCollabSet(entity, 'created_at', new Date().toISOString());
  await pushBestEffort(shareId);
}

/** Comments on a task (oldest first). */
export async function getComments(taskId: string): Promise<Comment[]> {
  return projectComments(await loadOps(), taskId);
}

/** Assign a task to a member (an editor-level op), then push best-effort. */
export async function setAssignee(shareId: string, taskId: string, actor: string): Promise<void> {
  const share=await getShare(shareId);if(!share) throw new Error('Unknown share.');
  await assertCurrentEpoch(share);const me=await actorId();const expected=await teamSnapshot();
  const roster=projectRoster(expected.ops,shareId);
  if(!editable(roster,me)) throw new Error('Only an owner or editor can assign tasks.');
  if(actor && !editable(roster,actor)) throw new Error('Choose a current owner/editor who can act on assigned tasks.');
  if(!expected.planning.tasks.some(t=>t.id===taskId && t.project_id===share.projectId && !t.deleted_at)) throw new Error('Task is outside this shared project.');
  await logCollabBatch([{entity:taskId,field:'assignee',value:actor}],expected);
  await pushBestEffort(shareId);
}

/** The current assignee actor for a task, if any. */
export async function getAssignee(taskId: string): Promise<string | null> {
  return projectAssignees(await loadOps()).get(taskId) ?? null;
}

/** The share's roster, folded from the local log (for display). */
export async function getRoster(shareId: string): Promise<Member[]> {
  return projectRoster(await loadOps(), shareId);
}

/** The activity feed for a share — its ops folded into human-readable events. */
export async function getActivity(shareId: string, limit = 30): Promise<ActivityEntry[]> {
  const meta = (await loadMetas()).find((m) => m.id === shareId);
  if (!meta) return [];
  const ops = await shareOps(meta);
  // Resolve task ids → titles for friendlier summaries.
  const titles = new Map<string, string>();
  for (const [id, s] of materialize(ops)) {
    if (isTaskEntity(id)) titles.set(id, entityStateToTask(id, s).title);
  }
  return projectActivity(ops, titles, limit);
}

/** The share (if any) that carries a given project's tasks. */
export async function shareForProject(projectId: string): Promise<ShareMeta | null> {
  return (await loadMetas()).find((m) => m.projectId === projectId) ?? null;
}

// ── Team auto-planning ───────────────────────────────────

export interface TeamPlanProposal extends TeamPlanResult {
  token:string;date:string;unavailable:Array<{actor:string;reason:string}>;taskTitles:Record<string,string>;
}
const proposals=new Map<string,{shareId:string;actor:string;date:string;epoch:number;expires:number;expected:Awaited<ReturnType<typeof teamSnapshot>>;assignments:TeamAssignment[]}>();
async function teamSnapshot() {
  const planning=await getPlanningSnapshot();
  return {tasks:planning.tasks.map(normalizedTask),projects:await getProjects(),ops:await loadOps(),planning,normalizeTask:normalizedTask,fingerprint};
}
function editable(roster:Member[],actor:string) {return roster.some(m=>m.actor===actor && (m.role==='owner' || m.role==='editor'));}

/** Publish only interval minutes and work bounds; calendar names/titles stay local. */
export async function publishMyAvailability(shareId:string,date:string):Promise<void> {
  const share=await getShare(shareId);if(!share) throw new Error('Unknown share.');
  await assertCurrentEpoch(share);const me=await actorId();
  await ensureCalendarCoverage(date);
  const warnings=await calendarWarnings(date);if(warnings.length) throw new Error('Refresh calendar availability before sharing: '+warnings.join(' '));
  const expected=await teamSnapshot();
  if(!projectRoster(expected.ops,shareId).some(m=>m.actor===me)) throw new Error('Sync to confirm your roster membership before sharing availability.');
  const work=await getWorkHours();
  const occupied=expected.planning.tasks.filter(t=>t.scheduled_start && t.scheduled_end && !t.deleted_at && (t.done || t.project_id!==share.projectId)).map(t=>({id:t.id,title:'',start:t.scheduled_start!,end:t.scheduled_end!,source:'local',created_at:''}));
  const busy=busyBlocksForDate([...expected.planning.calendar,...occupied],date).map(b=>({start_min:b.start_min,end_min:b.end_min}));
  const availability:TeamAvailability={version:1,date,published_at:new Date().toISOString(),work_start_min:work.start,work_end_min:work.end,busy};
  if(!validAvailability(availability)) throw new Error('Availability exceeds the supported interval count or has invalid working hours.');
  await logCollabBatch([{entity:`member:${shareId}:${me}`,field:'availability',value:availability as unknown as Json}],expected);
  await pushBestEffort(shareId);
}

/** Missing/stale calendars are excluded, never interpreted as free time. */
export async function planTeamForShare(shareId:string,date:string):Promise<TeamPlanProposal> {
  const share=await getShare(shareId);if(!share) throw new Error('Unknown share.');
  await assertCurrentEpoch(share);const me=await actorId();const expected=await teamSnapshot();
  const roster=projectRoster(expected.ops,shareId);
  if(!editable(roster,me)) throw new Error('Only a current owner or editor can propose assignments.');
  const unavailable:Array<{actor:string;reason:string}>=[];
  const members=roster.flatMap(m=>{
    const status=availabilityStatus(m.availability,date);
    if(!editable(roster,m.actor) || status!=='known') {unavailable.push({actor:m.actor,reason:!editable(roster,m.actor)?'Read-only role':status==='stale'?'Availability expired; share it again':'Availability not shared for this day'});return [];}
    const a=m.availability!;
    return [{actor:m.actor,work_start_min:a.work_start_min,work_end_min:a.work_end_min,busy:a.busy.map((b,i)=>({...b,id:`busy-${i}`,title:'Busy'}))}];
  });
  const assignees=projectAssignees(expected.ops);
  const tasks=expected.planning.tasks.filter(t=>t.project_id===share.projectId && !t.done && !t.deleted_at && !t.parent_id).map(t=>toTeamPlanTask(t,assignees.get(t.id) ?? null,date));
  const req={date,members,tasks};
  const result=IS_TAURI ? await (await import('@tauri-apps/api/core')).invoke<TeamPlanResult>('plan_team',{req}) : planTeam(req);
  const token=crypto.randomUUID();
  if(proposals.size>=20) proposals.delete(proposals.keys().next().value!);
  proposals.set(token,{shareId,actor:me,date,epoch:share.epoch ?? 1,expires:Date.now()+15*60_000,expected,assignments:result.assignments.map(a=>({...a}))});
  return {...result,token,date,unavailable,taskTitles:Object.fromEntries(tasks.map(t=>[t.id,t.title]))};
}

/** Apply the reviewed proposal as one guarded history transaction. No schedules are reserved. */
export async function applyTeamAssignments(shareId:string,proposal:TeamPlanProposal):Promise<void> {
  const saved=proposals.get(proposal.token);
  if(!saved || saved.shareId!==shareId || saved.date!==proposal.date || saved.expires<Date.now() || canonicalJson(saved.assignments as unknown as Json)!==canonicalJson(proposal.assignments as unknown as Json)) throw new Error('Proposal expired or changed. Balance workload again.');
  const share=await getShare(shareId);if(!share || (share.epoch ?? 1)!==saved.epoch) throw new Error('Share epoch changed. Review a new proposal.');
  await assertCurrentEpoch(share);const me=await actorId();const current=await teamSnapshot();
  if(fingerprint(current.tasks,current.projects,current.ops)!==fingerprint(saved.expected.tasks,saved.expected.projects,saved.expected.ops) || planInputKey(current.planning)!==planInputKey(saved.expected.planning)) throw new Error('Tasks, roster or availability changed. Review a fresh proposal.');
  const roster=projectRoster(current.ops,shareId);
  if(saved.actor!==me) throw new Error('Proposal belongs to another device identity.');
  if(!editable(roster,me)) throw new Error('Your role no longer permits assignments.');
  for(const a of saved.assignments) {
    if(!current.planning.tasks.some(t=>t.id===a.task_id && t.project_id===share.projectId && !t.deleted_at && !t.done)) throw new Error('Task changed. Review a fresh proposal.');
    const member=roster.find(m=>m.actor===a.actor);
    if(!member || !editable(roster,a.actor) || availabilityStatus(member.availability,proposal.date)!=='known') throw new Error('Availability expired or membership changed. Review a fresh proposal.');
  }
  await logCollabBatch(saved.assignments.map(a=>({entity:a.task_id,field:'assignee',value:a.actor})),saved.expected);
  proposals.delete(proposal.token);
  await pushBestEffort(shareId);
}

/** Push a share without throwing — used after a local collaboration write. */
async function pushBestEffort(shareId: string): Promise<void> {
  try {
    const share = await getShare(shareId);
    if (share?.url) await pushShare(share);
  } catch (e) {
    console.warn('[share] best-effort push failed (will retry on next sync):', e);
  }
}

// ── Per-share op extraction ──────────────────────────────

/** The ops belonging to a share: this project's task ops + the share's roster
 *  and comment ops. (Pure-ish: reads the local log, computes a subset.) */
export async function shareOps(share: ShareMeta): Promise<Op[]> {
  const all = await loadOps();
  const state = materialize(all);

  const taskIds = new Set<string>();
  for (const [id, s] of state) {
    if (isTaskEntity(id) && (s as any).project_id === share.projectId) taskIds.add(id);
  }
  for(const op of all) if(op.kind==='set' && op.field==='project_id' && op.value===share.projectId && !state.has(op.entity)) taskIds.add(op.entity);
  const memberPrefix = `member:${share.id}:`;
  const commentPrefix = `comment:${share.id}:`;
  const projectEntity = `project:${share.projectId}`;
  return all.filter(
    (op) =>
      taskIds.has(op.entity) ||
      op.entity === projectEntity ||
      op.entity.startsWith(memberPrefix) ||
      op.entity.startsWith(commentPrefix)
  );
}

// ── Push / pull / sync ───────────────────────────────────

export interface ShareSyncResult {
  pushed: number;
  admitted: number;
  rejected: number;
  upserts: number;
  deletes: number;
  roster: Member[];
  myRole: Role;
}

/** Seal this project's signed ops under the share key and upload them. */
export async function pushShare(share:Share):Promise<number> {
  return withSyncLock(await roomIdForSecret(share.secret),async()=>{await pullShareUnlocked(share);await assertCurrentEpoch(share);return pushShareUnlocked(share);});
}
async function assertCurrentEpoch(share:Share):Promise<void> {
  const required=Number(await getSetting(`share_required_epoch:${share.id}`,'1'));
  if(required>(share.epoch ?? 1)) throw new Error('This share key was revoked or rotated. Ask the owner for the new signed invitation before uploading.');
}
async function pushShareUnlocked(share: Share): Promise<number> {
  if (!share.url) throw new Error('This share has no relay URL configured.');
  const ops = await shareOps(share);
  const key=await importShareKey(share.secret),room=await roomIdForSecret(share.secret);
  return pushBatches({url:share.url,room,key,context:{kind:'share',id:share.id,epoch:share.epoch ?? 1}},ops);
}

/** Fetch the room, decrypt, verify, authorize, ingest, and reconcile. */
export async function pullShare(share:Share):Promise<Omit<ShareSyncResult,'pushed'>> {
  return withSyncLock(await roomIdForSecret(share.secret),()=>pullShareUnlocked(share));
}
async function pullShareUnlocked(share: Share): Promise<Omit<ShareSyncResult, 'pushed'>> {
  if (!share.url) throw new Error('This share has no relay URL configured.');
  const key = await importShareKey(share.secret);
  const room = await roomIdForSecret(share.secret);

  const pulled=await pullBatches({url:share.url,room,key,context:{kind:'share',id:share.id,epoch:share.epoch ?? 1},trustedBindings:{[share.genesis.actor]:share.genesis.pub}},async archive=>{
    const localState=materialize(await loadOps());
    const taskIds=new Set<string>(),forbiddenTaskIds=new Set<string>();
    for(const [id,task] of localState) if(isTaskEntity(id)) (task.project_id===share.projectId?taskIds:forbiddenTaskIds).add(id);
    const res=authorizeVerified(archive.flatMap(batch=>batch.ops.map(op=>({op,pub:batch.pub}))),share.genesis,{shareId:share.id,projectId:share.projectId,taskIds,forbiddenTaskIds});
    const projection=await mergeIntoApp(res.accepted);
    return {...res,...projection};
  });
  const res=pulled.result;
  const epochs=res.accepted.filter(op=>op.kind==='set' && op.entity.startsWith(`member:${share.id}:`) && op.field==='read_epoch' && Number.isSafeInteger(op.value)).map(op=>op.kind==='set'?Number(op.value):0);
  const previous=Number(await getSetting(`share_required_epoch:${share.id}`,'1'));
  await setSetting(`share_required_epoch:${share.id}`,String(Math.max(previous,...epochs)));
  const {upserts,deletes}=res;

  // Materialize any shared project record so a joiner sees it named + grouped.
  const sharedProjects = projectSharedProjects(await loadOps());
  if (sharedProjects.length > 0) {
    for (const p of sharedProjects) await upsertProjectRaw(p);
    await loadProjects(); // refresh the sidebar/store
  }

  // Update our cached role from the roster the doc now reflects.
  const me = await actorId();
  const myRole = res.roster.get(me)?.role ?? share.role;
  if (myRole !== share.role) {
    const { secret: _omit, ...meta } = share;
    await upsertMeta({ ...meta, role: myRole });
  }

  return {
    admitted: res.admitted.length,
    rejected: res.rejected.length,
    upserts,
    deletes,
    roster: [...res.roster.values()],
    myRole,
  };
}

/** One full share sync: push our contribution, then pull everyone's. */
export async function syncShare(shareId: string,options:{automatic?:boolean}={}): Promise<ShareSyncResult> {
  const share = await getShare(shareId);
  if (!share) throw new Error('Unknown share.');
  const room=await roomIdForSecret(share.secret);
  if(options.automatic) await checkRetryWindow(room,share.url);
  return withSyncLock(room,async()=>{
    await pullShareUnlocked(share);await assertCurrentEpoch(share);
    const pushed=await pushShareUnlocked(share);
    return {pushed,...await pullShareUnlocked(share)};
  });
}

/** The relay's cheap change-counter for a share's room. Lets a client poll for
 *  "did anything change?" without a full decrypt+merge round-trip. 0 on error. */
export async function shareRoomVersion(shareId: string): Promise<number> {
  const share = await getShare(shareId);
  if (!share?.url) return 0;
  try {
    const room = await roomIdForSecret(share.secret);
    const raw = await httpGet(`${share.url}/v2/rooms/${room}/version`);
    const v = JSON.parse(raw)?.version;
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

/** Long-poll the relay for a change to a share's room: the request is held
 *  server-side until the version moves past `since` (or a timeout), giving
 *  near-instant updates without websockets. Returns the current version. */
export async function shareRoomPoll(shareId: string, since: number): Promise<number> {
  const share = await getShare(shareId);
  if (!share?.url) return since;
  try {
    const room = await roomIdForSecret(share.secret);
    const raw = await httpGet(`${share.url}/v2/rooms/${room}/poll?since=${since}`);
    const v = JSON.parse(raw)?.version;
    return typeof v === 'number' ? v : since;
  } catch {
    return since;
  }
}

/** Sync every share we participate in (best-effort per share). */
export async function syncAllShares(options:{automatic?:boolean}={}): Promise<Record<string, ShareSyncResult | { error: string }>> {
  const out: Record<string, ShareSyncResult | { error: string }> = {};
  for (const meta of await loadMetas()) {
    try {
      out[meta.id] = await syncShare(meta.id,options);
    } catch (e) {
      out[meta.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

export { memberActor };
