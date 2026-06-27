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

import { IS_TAURI, getSetting, setSetting, loadOps, getProjects, upsertProjectRaw } from '../db';
import { getSecret, setSecret } from '../utils/secrets';
import { materialize, type Op } from './oplog';
import { isTaskEntity, entityStateToTask, projectTasks } from './projector';
import { projectActivity, type ActivityEntry } from './activity';
import { getWorkHours, DEFAULT_WORK_START, DEFAULT_WORK_END } from './planService';
import { planTeam, toTeamPlanTask, type TeamPlanResult, type TeamAssignment } from './teamPlanService';
import { loadProjects } from './taskService';
import { generateShareSecret, importShareKey, roomIdForSecret, seal, open, type SealedBlob } from './crypto';
import { publicIdentity, signLocalOps } from './identity';
import { authorize, memberActor, type Member, type Role, type SignedOp } from './collab';
import { projectComments, projectRoster, projectAssignees, projectSharedProjects, type Comment } from './collabProjection';
import { logCollabSet, logCollabDel, ingestOps, actorId } from './oplogStore';
import { reconcileIntoApp } from './syncService';
import { httpGet, httpPut, blobsUrl } from './relayTransport';

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
}

/** A share with its secret loaded — the form push/pull need. */
export interface Share extends ShareMeta {
  secret: string;
}

/** A portable invite. The `secret` is a capability — share it securely. */
export interface InviteToken {
  v: 1;
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

  const invite: InviteToken = { v: 1, id, name, projectId, url: relayUrl, secret, genesis: meta.genesis };
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
  if (t.v !== 1 || !t.id || !t.secret || !t.genesis?.pub) throw new Error('Invalid invite token.');

  const meta: ShareMeta = { id: t.id, name: t.name, projectId: t.projectId, url: (t.url ?? '').replace(/\/$/, ''), role: 'viewer', genesis: t.genesis };
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
  await logCollabDel(`member:${shareId}:${actor}`);
}

/** Re-derive the shareable invite token for an existing share (to copy again). */
export async function inviteFor(shareId: string): Promise<string> {
  const share = await getShare(shareId);
  if (!share) throw new Error('Unknown share.');
  const invite: InviteToken = {
    v: 1,
    id: share.id,
    name: share.name,
    projectId: share.projectId,
    url: share.url,
    secret: share.secret,
    genesis: share.genesis,
  };
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
  await logCollabSet(taskId, 'assignee', actor);
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

/**
 * Balance and schedule a shared project's open tasks across its roster for a
 * day. Each member's tasks (explicit assignee + balanced unassigned) are laid
 * out with the deterministic solver. NOTE: we only know our own work hours /
 * calendar; teammates default to standard hours with no busy blocks until
 * presence/calendar sharing lands.
 */
export async function planTeamForShare(shareId: string, date: string): Promise<TeamPlanResult> {
  const meta = (await loadMetas()).find((m) => m.id === shareId);
  if (!meta) throw new Error('Unknown share.');
  const ops = await loadOps();
  const roster = projectRoster(ops, shareId);
  if (roster.length === 0) throw new Error('No members to plan for yet — sync the share first.');

  const assignees = projectAssignees(ops);
  const me = await actorId();
  const work = await getWorkHours();

  // Prefer each member's self-declared hours; fall back to our live hours for
  // ourselves, or standard hours for teammates who haven't published any.
  const members = roster.map((m) => ({
    actor: m.actor,
    work_start_min: m.work_start_min ?? (m.actor === me ? work.start : DEFAULT_WORK_START),
    work_end_min: m.work_end_min ?? (m.actor === me ? work.end : DEFAULT_WORK_END),
    busy: [],
  }));

  const tasks = projectTasks(ops)
    .filter((t) => t.project_id === meta.projectId && !t.done && !t.deleted_at && !t.parent_id)
    .map((t) => toTeamPlanTask(t, assignees.get(t.id) ?? null));

  const req = { date, members, tasks };
  // Use the deterministic Rust solver on desktop; the TS mirror everywhere else.
  if (IS_TAURI) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<TeamPlanResult>('plan_team', { req });
  }
  return planTeam(req);
}

/** Persist a balancing proposal as assignee ops, then push (editor-level). */
export async function applyTeamAssignments(shareId: string, assignments: TeamAssignment[]): Promise<void> {
  for (const a of assignments) await logCollabSet(a.task_id, 'assignee', a.actor);
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
export async function pushShare(share: Share): Promise<number> {
  if (!share.url) throw new Error('This share has no relay URL configured.');
  const ops = await shareOps(share);
  const signed = await signLocalOps(ops);
  const key = await importShareKey(share.secret);
  const room = await roomIdForSecret(share.secret);
  const me = await actorId();
  await httpPut(`${blobsUrl(share.url, room)}/${me}`, JSON.stringify(await seal(key, signed)));
  return ops.length;
}

/** Fetch the room, decrypt, verify, authorize, ingest, and reconcile. */
export async function pullShare(share: Share): Promise<Omit<ShareSyncResult, 'pushed'>> {
  if (!share.url) throw new Error('This share has no relay URL configured.');
  const key = await importShareKey(share.secret);
  const room = await roomIdForSecret(share.secret);

  const raw = await httpGet(blobsUrl(share.url, room));
  const parsed = JSON.parse(raw);
  const blobs: (SealedBlob & { actor?: string })[] = Array.isArray(parsed) ? parsed : parsed.blobs ?? [];

  const incoming: SignedOp[] = [];
  for (const blob of blobs) {
    try {
      incoming.push(...(await open<SignedOp[]>(key, blob)));
    } catch (e) {
      console.warn('[share] skipped an undecryptable/foreign blob:', e);
    }
  }

  // Verify signatures + apply RBAC against the doc's genesis owner.
  const res = await authorize(incoming, share.genesis);
  await ingestOps(res.accepted); // only authenticated, authorized ops enter our log
  const { upserts, deletes } = await reconcileIntoApp();

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
export async function syncShare(shareId: string): Promise<ShareSyncResult> {
  const share = await getShare(shareId);
  if (!share) throw new Error('Unknown share.');
  const pushed = await pushShare(share);
  const pulled = await pullShare(share);
  return { pushed, ...pulled };
}

/** The relay's cheap change-counter for a share's room. Lets a client poll for
 *  "did anything change?" without a full decrypt+merge round-trip. 0 on error. */
export async function shareRoomVersion(shareId: string): Promise<number> {
  const share = await getShare(shareId);
  if (!share?.url) return 0;
  try {
    const room = await roomIdForSecret(share.secret);
    const raw = await httpGet(`${share.url}/rooms/${room}/version`);
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
    const raw = await httpGet(`${share.url}/rooms/${room}/poll?since=${since}`);
    const v = JSON.parse(raw)?.version;
    return typeof v === 'number' ? v : since;
  } catch {
    return since;
  }
}

/** Sync every share we participate in (best-effort per share). */
export async function syncAllShares(): Promise<Record<string, ShareSyncResult | { error: string }>> {
  const out: Record<string, ShareSyncResult | { error: string }> = {};
  for (const meta of await loadMetas()) {
    try {
      out[meta.id] = await syncShare(meta.id);
    } catch (e) {
      out[meta.id] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}

export { memberActor };
