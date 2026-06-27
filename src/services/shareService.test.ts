import { describe, it, expect, beforeEach, vi } from 'vitest';

// Keep SQLite reconciliation out of this unit — we're proving the SHARE
// protocol (extract → sign → seal → relay → decrypt → verify → authorize →
// ingest). Convergence is asserted on the op-log projection directly.
vi.mock('./syncService', () => ({
  reconcileIntoApp: vi.fn(async () => ({ upserts: 0, deletes: 0 })),
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
class FakeRelay {
  rooms = new Map<string, Map<string, any>>();
  versions = new Map<string, number>();
  handle(method: string, url: string, body?: string) {
    const path = new URL(url).pathname.split('/').filter(Boolean); // [rooms, room, blobs|version, actor?]
    const room = path[1];
    if (method === 'PUT' && path[3]) {
      if (!this.rooms.has(room)) this.rooms.set(room, new Map());
      this.rooms.get(room)!.set(path[3], JSON.parse(body!));
      this.versions.set(room, (this.versions.get(room) ?? 0) + 1);
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    }
    if (method === 'GET' && path[2] === 'blobs') {
      const blobs = [...(this.rooms.get(room) ?? new Map()).entries()].map(([actor, b]) => ({ actor, ...b }));
      return { ok: true, status: 200, text: async () => JSON.stringify({ blobs }) };
    }
    if (method === 'GET' && (path[2] === 'version' || path[2] === 'poll')) {
      // The fake returns the current version immediately (no real long-poll wait).
      return { ok: true, status: 200, text: async () => JSON.stringify({ version: this.versions.get(room) ?? 0 }) };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  }
}

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
