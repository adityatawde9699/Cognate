import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./syncService', () => ({
  mergeIntoApp: vi.fn(async (ops) => ({ applied: await (await import('./oplogStore')).ingestOps(ops), upserts: 0, deletes: 0 })),
}));

import { _resetForTests as resetIdentity } from './identity';
import {
  createWorkspaceGenesis,
  joinWorkspaceV3,
  migrateV2ToV3,
  isV2WriteFrozen,
  retireLegacyV2Room,
  cancelLegacyV2SoftDelete,
  checkAllActorsSyncedV3,
} from './migrationService';
import {
  enableSync,
  getConfig,
  getWorkspaceBinding,
  syncNow,
} from './relayService';
import { logTaskUpsert, _resetForTests } from './oplogStore';
import { FakeBatchRelay as FakeRelay } from './fixtures/fakeBatchRelay';
import { encodeSetupCode, deriveSyncV3, decodeSetupCode, deriveSyncKey, deriveRoomId, seal } from './crypto';
import type { Task } from '../store';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
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
const PASS_V2 = 'legacy-v2-passphrase';
const PASS_V3 = 'correct horse battery staple';
const SETUP_RAW = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
const SETUP_CODE = encodeSetupCode(SETUP_RAW);

describe('Sync Protocol v3 Genesis, Join & Migration State Machine', () => {
  let A: MemStorage, B: MemStorage, relay: FakeRelay;

  beforeEach(() => {
    A = new MemStorage();
    B = new MemStorage();
    A.setItem('cn_set_sync_v3_enabled', 'true');
    B.setItem('cn_set_sync_v3_enabled', 'true');
    relay = new FakeRelay();
    (globalThis as any).fetch = vi.fn((url: string, init?: any) =>
      Promise.resolve(relay.handle(init?.method ?? 'GET', url, init?.body) as any)
    );
  });

  describe('Workspace Genesis (Section 5.1)', () => {
    it('creates signed genesis batch with verifier and registers delete token hash', async () => {
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();

      const res = await createWorkspaceGenesis(RELAY, PASS_V3, SETUP_CODE);
      expect(res.room).toBe('af340eac1d2451afe20f762a4a8cb695');
      expect(res.setupCode).toBe(SETUP_CODE);
      expect(res.deleteToken).toMatch(/^[0-9a-f]{32}$/);
      expect(res.workspaceId).toBeDefined();

      // Check relay holds the genesis batch
      const storedRoom = relay.rooms.get(res.room);
      expect(storedRoom).toBeDefined();
      expect(storedRoom?.has('genesis')).toBe(true);

      // Verify delete token hash was registered in relay meta
      const meta = relay.roomMeta.get(res.room);
      expect(meta?.delete_token_hash).toBeDefined();

      // Check local configuration updated to v3
      const cfg = await getConfig();
      expect(cfg?.version).toBe(3);
      expect(cfg?.setupCode).toBe(SETUP_CODE);
    });
  });

  describe('Workspace Join Pipeline (Section 5.2)', () => {
    beforeEach(async () => {
      // Create workspace genesis on Device A
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      await createWorkspaceGenesis(RELAY, PASS_V3, SETUP_CODE);
    });

    it('Step 1 (Existence): fails immediately if no workspace exists for credentials', async () => {
      (globalThis as any).localStorage = B;
      _resetForTests(); resetIdentity();

      // Non-existent setup code derives an empty room
      const otherSetup = encodeSetupCode(new Uint8Array(16).fill(0x55));
      await expect(joinWorkspaceV3(RELAY, PASS_V3, otherSetup)).rejects.toThrow(
        /No workspace found for this Setup Code and Passphrase/i
      );
    });

    it('Step 2 (Decryption): fails with Incorrect Passphrase when batch decryption fails', async () => {
      (globalThis as any).localStorage = B;
      _resetForTests(); resetIdentity();

      const wrongPass = 'completely-wrong-passphrase-here';
      const wrongCreds = await deriveSyncV3(wrongPass, SETUP_RAW);
      // Seed wrongCreds.room with a batch sealed with another key
      const otherKey = await deriveSyncKey('some-other-key-material');
      const fakeBatch = await seal(otherKey, { v: 3, id: 'genesis' });
      relay.handle('PUT', `${RELAY}/v2/rooms/${wrongCreds.room}/batches/genesis`, JSON.stringify(fakeBatch));

      await expect(joinWorkspaceV3(RELAY, wrongPass, SETUP_CODE)).rejects.toThrow(
        /Incorrect Passphrase/i
      );
    });

    it('Step 4 & Success: joins existing workspace when all 4 steps succeed', async () => {
      (globalThis as any).localStorage = B;
      _resetForTests(); resetIdentity();

      const res = await joinWorkspaceV3(RELAY, PASS_V3, SETUP_CODE);
      expect(res.room).toBe('af340eac1d2451afe20f762a4a8cb695');
      expect(res.workspaceId).toBeDefined();

      const cfg = await getConfig();
      expect(cfg?.version).toBe(3);
      expect(cfg?.setupCode).toBe(SETUP_CODE);
    });
  });

  describe('Migration Orchestrator v2 -> v3 (Section 6)', () => {
    beforeEach(async () => {
      // Device A live on v2
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      await enableSync(RELAY, PASS_V2);
      await logTaskUpsert(task('v2-t1', { title: 'v2 Legacy Task' }));
      await syncNow();
    });

    it('migrates v2 to v3, posts migration marker without leaking v3 room or keys, and enters write-freeze', async () => {
      const v2Room = await deriveRoomId(PASS_V2);

      const migration = await migrateV2ToV3(PASS_V3, SETUP_CODE);
      expect(migration.v3Room).toBe('af340eac1d2451afe20f762a4a8cb695');
      expect(migration.setupCode).toBe(SETUP_CODE);

      // Verify v2 write-freeze is active on Device A
      expect(await isV2WriteFrozen()).toBe(true);

      // Verify v2 room on relay received migration marker
      const v2Records = relay.rooms.get(v2Room);
      expect(v2Records).toBeDefined();
      const markerEntry = [...v2Records!.values()].find((r) => r.batch_id?.startsWith('migrated-'));
      expect(markerEntry).toBeDefined();

      // Verify privacy property: raw marker ciphertext must NOT leak v3 room ID
      const markerDump = JSON.stringify(markerEntry);
      expect(markerDump).not.toContain(migration.v3Room);
      expect(markerDump).not.toContain(migration.setupCode);

      // Verify local configuration and binding updated to v3 with v2 fallback
      const cfg = await getConfig();
      expect(cfg?.version).toBe(3);
      expect(cfg?.setupCode).toBe(SETUP_CODE);

      const binding = await getWorkspaceBinding();
      expect(binding?.version).toBe(3);
      expect(binding?.room).toBe(migration.v3Room);
      expect(binding?.v2_fallback?.room).toBe(v2Room);
    });

    it('migrating device freezes v2 room ONLY after v3 readback succeeds; failed readback leaves v2 writable', async () => {
      const v2Room = await deriveRoomId(PASS_V2);
      const originalHandle = relay.handle.bind(relay);
      relay.handle = (method: string, url: string, body?: string) => {
        if (method === 'GET' && url.includes('/batches') && !url.includes(v2Room)) {
          // Simulate empty/corrupt readback on v3 room
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ batches: [], last_cursor: 0 }),
          };
        }
        return originalHandle(method, url, body);
      };

      try {
        await expect(migrateV2ToV3(PASS_V3, SETUP_CODE)).rejects.toThrow(/readback verification failed/i);
        // Critical safety invariant: v2 write-freeze MUST NOT be active
        expect(await isV2WriteFrozen()).toBe(false);

        // Verify v2 remains writable: local changes sync to v2 without throwing write-freeze error
        await logTaskUpsert(task('v2-t2', { title: 'v2 Remains Writable After Failed Readback' }));
        await expect(syncNow()).resolves.toBeDefined();
      } finally {
        relay.handle = originalHandle;
      }
    });

    it('remote device pulling from v2 receives migration marker and enters write-freeze', async () => {
      // Device B also on v2
      (globalThis as any).localStorage = B;
      _resetForTests(); resetIdentity();
      await enableSync(RELAY, PASS_V2);
      await syncNow(); // pulls task v2-t1
      expect(await isV2WriteFrozen()).toBe(false);

      // Device A performs migration
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      await migrateV2ToV3(PASS_V3, SETUP_CODE);

      // Device B syncs on v2 and discovers migration marker
      (globalThis as any).localStorage = B;
      _resetForTests(); resetIdentity();
      await syncNow();

      // Device B is now write-frozen on v2
      expect(await isV2WriteFrozen()).toBe(true);

      // Subsequent attempt by Device B to push to v2 fails with write-freeze error
      await logTaskUpsert(task('v2-t2', { title: 'Forbidden write after migration' }));
      await expect(syncNow()).rejects.toThrow(/write-freeze/i);
    });
  });

  describe('Relay Soft-Delete and Undelete (Section 6.4)', () => {
    it('retires legacy room via delete token, gates with 410 Gone, and supports undelete', async () => {
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      const genesis = await createWorkspaceGenesis(RELAY, PASS_V3, SETUP_CODE);

      // Verify room is currently active
      const activeRes = relay.handle('GET', `${RELAY}/v2/rooms/${genesis.room}/batches?after=0`);
      expect(activeRes.status).toBe(200);

      // Trigger soft-delete presenting delete token
      const deleteRes = await retireLegacyV2Room(RELAY, genesis.room, genesis.deleteToken);
      expect(deleteRes.soft_deleted).toBe(true);
      expect(deleteRes.purge_after_seconds).toBe(604800);

      // Further batch operations on soft-deleted room must be gated with 410 Gone
      const gatedRes = relay.handle('GET', `${RELAY}/v2/rooms/${genesis.room}/batches?after=0`);
      expect(gatedRes.status).toBe(410);

      // Cancel soft-delete via undelete endpoint
      const undeleteRes = await cancelLegacyV2SoftDelete(RELAY, genesis.room, genesis.deleteToken);
      expect(undeleteRes.soft_deleted).toBe(false);
      expect(undeleteRes.undeleted).toBe(true);

      // Room is active again
      const restoredRes = relay.handle('GET', `${RELAY}/v2/rooms/${genesis.room}/batches?after=0`);
      expect(restoredRes.status).toBe(200);
    });

    it('rejects soft-delete when delete token does not match registered hash', async () => {
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      const genesis = await createWorkspaceGenesis(RELAY, PASS_V3, SETUP_CODE);

      const fakeToken = '00000000000000000000000000000000';
      await expect(retireLegacyV2Room(RELAY, genesis.room, fakeToken)).rejects.toThrow();
    });

    it('checkAllActorsSyncedV3 verifies whether all known actors have synced to v3', async () => {
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      await enableSync(RELAY, PASS_V2);
      await logTaskUpsert(task('t1', { title: 'Task 1' }));
      await syncNow();

      const v2Room = await deriveRoomId(PASS_V2);
      const v2Key = await deriveSyncKey(PASS_V2);

      const migration = await migrateV2ToV3(PASS_V3, SETUP_CODE);
      const creds = await deriveSyncV3(PASS_V3, decodeSetupCode(SETUP_CODE));

      // Device A on v3 publishes a batch
      await logTaskUpsert(task('t2', { title: 'Task 2' }));
      await syncNow();

      const check = await checkAllActorsSyncedV3(RELAY, v2Room, migration.v3Room, v2Key, creds.key);
      expect(check.allSynced).toBe(true);
      expect(check.missingActors).toEqual([]);
    });

    it('claimLegacyV2Room claims an unclaimed room and rejects duplicate claims', async () => {
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      const v2Room = await deriveRoomId(PASS_V2);
      // Simulate existing legacy room without delete token
      relay.rooms.set(v2Room, new Map([['b1', { v: 1, nonce: 'n1', ct: 'c1', cursor: 1 }]]));
      relay.roomMeta.set(v2Room, {});

      const token = 'legacy_delete_token_preimage';
      const claimRes = await (await import('./migrationService')).claimLegacyV2Room(RELAY, v2Room, token);
      expect(claimRes.claimed).toBe(true);

      // Duplicate claim must be rejected (anti-squatting)
      await expect((await import('./migrationService')).claimLegacyV2Room(RELAY, v2Room, 'attacker_token')).rejects.toThrow();
    });

    it('migrating device freezes v2 room on real/capable relay and writes are rejected', async () => {
      (globalThis as any).localStorage = A;
      _resetForTests(); resetIdentity();
      await enableSync(RELAY, PASS_V2);
      await logTaskUpsert(task('t1', { title: 'Task 1' }));
      await syncNow();

      const v2Room = await deriveRoomId(PASS_V2);
      await migrateV2ToV3(PASS_V3, SETUP_CODE);

      // Verify v2 room is frozen on relay
      const meta = relay.roomMeta.get(v2Room);
      expect(meta?.frozen_at).toBeDefined();

      // Subsequent PUT to frozen v2 room must fail with 409
      const putRes = relay.handle('PUT', `${RELAY}/v2/rooms/${v2Room}/batches/b_stale`, JSON.stringify({ v: 1, nonce: 'n2', ct: 'c2' }));
      expect(putRes.status).toBe(409);
    });
  });
});
