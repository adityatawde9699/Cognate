import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep SQLite reconciliation out of this unit — we're proving the SHARE
// protocol (extract → sign → seal → relay → decrypt → verify → authorize →
// ingest). Convergence is asserted on the op-log projection directly.
vi.mock('./syncService', () => ({
  mergeIntoApp: vi.fn(async (ops) => ({ applied: await (await import('./oplogStore')).ingestOps(ops), upserts: 0, deletes: 0 })),
}));

import { createShare, joinShare, syncShare, grantRole, getShare, addComment, getComments, shareRoomVersion, shareRoomPoll } from './shareService';
import { createProject, getProjects } from '../db';
import { logTaskUpsert, _resetForTests as resetOplog } from './oplogStore';
import { publicIdentity, _resetForTests as resetIdentity } from './identity';
import { projectTasks } from './projector';
import { loadOps } from '../db';
import type { Task } from '../store';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// In-memory stand-in for the Rust relay, matching its contract exactly.
import {FakeBatchRelay as FakeRelay} from './fixtures/fakeBatchRelay';

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, description: '', deadline: '', tags: [], importance: 3, effort: 3,
    done: false, created_at: '2026-01-01', completed_at: null, pomodoros_spent: 0, priority: 'medium',
    sort_order: 0, project_id: null, parent_id: null, recurrence: 'none', milestone_id: null,
    custom_fields: {}, deleted_at: null, energy: 'med', pinned: false, ...over,
  };
}

const RELAY = 'https://relay.example';

/** Run fn "as" a device: switch its storage, reset per-module caches. */
async function as<T>(store: MemStorage, fn: () => Promise<T>): Promise<T> {
  (globalThis as any).localStorage = store;
  resetOplog();
  resetIdentity();
  return fn();
}

describe('shareService — shared projects over the E2E relay', () => {
  let A: MemStorage, B: MemStorage, relay: FakeRelay;

  beforeEach(() => {
    A = new MemStorage();
    B = new MemStorage();
    relay = new FakeRelay();
    (globalThis as any).fetch = vi.fn((url: string, init?: any) =>
      Promise.resolve(relay.handle(init?.method ?? 'GET', url, init?.body) as any)
    );
  });

  it('shares a project A→B, storing only ciphertext on the relay', async () => {
    let invite = '';
    await as(A, async () => {
      await logTaskUpsert(task('t1', { title: 'SUPERSECRETSPEC', project_id: 'p1' }));
      ({ invite } = await createShare('p1', 'Team Alpha', RELAY));
      await syncShare((await getShareIdFrom(invite)));
    });

    // The relay never holds plaintext — sealed blobs only.
    const dump = JSON.stringify([...relay.rooms.values()].map((m) => [...m.values()]));
    expect(dump).not.toContain('SUPERSECRETSPEC');
    expect(dump).toContain('"ct"');

    // B joins with the invite and syncs → the task converges into B's log.
    await as(B, async () => {
      const share = await joinShare(invite);
      await syncShare(share.id);
      const tasks = projectTasks(await loadOps());
      expect(tasks.find((t) => t.id === 't1')?.title).toBe('SUPERSECRETSPEC');
    });
  });

  it('enforces RBAC: a viewer’s edits are rejected until an owner grants editor', async () => {
    let invite = '';
    let shareId = '';
    await as(A, async () => {
      await logTaskUpsert(task('t1', { title: 'original', project_id: 'p1' }));
      const r = await createShare('p1', 'Team', RELAY);
      invite = r.invite;
      shareId = r.share.id;
      await syncShare(shareId);
    });

    // B joins (viewer), pulls the task, then tries to rename it.
    let bActor = '';
    await as(B, async () => {
      const share = await joinShare(invite);
      await syncShare(share.id);
      bActor = (await publicIdentity()).actor;
      // B edits as a mere viewer — should be rejected by peers.
      await logTaskUpsert(task('t1', { title: 'VIEWER-HIJACK', project_id: 'p1' }));
      await syncShare(share.id);
    });

    // A pulls: B is only a viewer, so the hijack is rejected; title unchanged.
    await as(A, async () => {
      const res = await syncShare(shareId);
      expect(res.rejected).toBeGreaterThan(0);
      const tasks = projectTasks(await loadOps());
      expect(tasks.find((t) => t.id === 't1')?.title).toBe('original');
      expect(res.roster.find((m) => m.actor === bActor)?.role).toBe('viewer');

      // Owner promotes B to editor and re-publishes.
      await grantRole(shareId, bActor, 'editor');
      await syncShare(shareId);
    });

    // B pulls the grant, edits again — now causally after becoming an editor.
    await as(B, async () => {
      const share = await getShare(shareId);
      await syncShare(share!.id); // receive the role grant first
      expect(share).toBeTruthy();
      await logTaskUpsert(task('t1', { title: 'EDITOR-APPROVED', project_id: 'p1' }));
      await syncShare(shareId);
    });

    // A pulls: B is now an editor, so this edit IS admitted.
    await as(A, async () => {
      await syncShare(shareId);
      const tasks = projectTasks(await loadOps());
      expect(tasks.find((t) => t.id === 't1')?.title).toBe('EDITOR-APPROVED');
    });
  });

  it('propagates a comment from the owner to a joiner', async () => {
    let invite = '';
    let shareId = '';
    await as(A, async () => {
      await logTaskUpsert(task('t1', { title: 'Task', project_id: 'p1' }));
      const r = await createShare('p1', 'Team', RELAY);
      invite = r.invite;
      shareId = r.share.id;
      await addComment(shareId, 't1', 'hello team'); // pushes best-effort
      await syncShare(shareId);
    });

    await as(B, async () => {
      const share = await joinShare(invite);
      await syncShare(share.id);
      const comments = await getComments('t1');
      expect(comments.map((c) => c.body)).toContain('hello team');
    });
  });

  it('exposes a room version that bumps on each push (near-real-time signal)', async () => {
    await as(A, async () => {
      await logTaskUpsert(task('t1', { project_id: 'p1' }));
      const r = await createShare('p1', 'Team', RELAY);
      const v0 = await shareRoomVersion(r.share.id);
      expect(v0).toBe(0); // nothing pushed yet
      await syncShare(r.share.id); // pushes our blob
      const v1 = await shareRoomVersion(r.share.id);
      expect(v1).toBeGreaterThan(v0);
      // Long-poll observes the moved version (returns != since).
      expect(await shareRoomPoll(r.share.id, v0)).toBe(v1);
    });
  });

  it('carries the project record so a joiner sees it named', async () => {
    let invite = '';
    let projId = '';
    await as(A, async () => {
      const proj = await createProject('Q3 Roadmap');
      projId = proj.id;
      await logTaskUpsert(task('t1', { title: 'Plan', project_id: projId }));
      const r = await createShare(projId, 'Roadmap share', RELAY);
      invite = r.invite;
      await syncShare(r.share.id);
    });

    await as(B, async () => {
      const share = await joinShare(invite);
      await syncShare(share.id);
      const projects = await getProjects();
      expect(projects.find((p: any) => p.id === projId)?.name).toBe('Q3 Roadmap');
    });
  });
});

/** Decode the share id out of an invite without exposing the codec in the API. */
async function getShareIdFrom(invite: string): Promise<string> {
  const json = JSON.parse(decodeURIComponent(escape(atob(invite))));
  return json.id as string;
}

it('rotates the read room on removal and preserves current content for remaining members',async()=>{
  const A=new MemStorage(),B=new MemStorage(),C=new MemStorage(),relay=new FakeRelay();
  vi.stubGlobal('fetch',vi.fn(async(url,init)=>relay.handle(init?.method ?? 'GET',url,init?.body)));
  const {removeMember,inviteFor,rotateShareKey}=await import('./shareService');
  let invite='',shareId='',bActor='',oldSecret='';
  await as(A,async()=>{await logTaskUpsert(task('t1',{project_id:'p1',title:'original'}));const r=await createShare('p1','Team',RELAY);invite=r.invite;shareId=r.share.id;oldSecret=r.share.secret;await syncShare(shareId);});
  await as(B,async()=>{await joinShare(invite);bActor=(await publicIdentity()).actor;await syncShare(shareId);});
  await as(A,async()=>{await syncShare(shareId);await grantRole(shareId,bActor,'editor');await syncShare(shareId);});
  await as(B,async()=>{await syncShare(shareId);await logTaskUpsert(task('t1',{project_id:'p1',title:'editor version'}));await syncShare(shareId);});
  let rotated='';
  await as(A,async()=>{await syncShare(shareId);await removeMember(shareId,bActor);const share=(await getShare(shareId))!;expect(share.epoch).toBe(2);expect(share.secret).not.toBe(oldSecret);rotated=await inviteFor(shareId);await logTaskUpsert(task('t1',{project_id:'p1',title:'after revocation'}));await syncShare(shareId);await expect(joinShare(invite)).rejects.toThrow('downgrade');});
  await as(B,async()=>{await expect(syncShare(shareId)).rejects.toThrow('revoked or rotated');expect(projectTasks(await loadOps()).find(t=>t.id==='t1')?.title).toBe('editor version');await expect(rotateShareKey(shareId)).rejects.toThrow('genesis owner');});
  await as(C,async()=>{await joinShare(rotated);await syncShare(shareId);expect(projectTasks(await loadOps()).find(t=>t.id==='t1')?.title).toBe('after revocation');});
});
it('rejects tampered invitations before persisting share capabilities',async()=>{
  const A=new MemStorage(),B=new MemStorage();let invite='';
  await as(A,async()=>{invite=(await createShare('p1','Team',RELAY)).invite;});
  const token=JSON.parse(decodeURIComponent(escape(atob(invite))));token.projectId='foreign';
  const tampered=btoa(unescape(encodeURIComponent(JSON.stringify(token))));
  await as(B,async()=>{await expect(joinShare(tampered)).rejects.toThrow('signature');expect(await getShare(token.id)).toBeNull();});
});
