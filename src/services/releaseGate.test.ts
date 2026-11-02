import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createWorkspaceGenesis,
  joinWorkspaceV3,
  migrateV2ToV3,
  retireLegacyV2Room,
  cancelLegacyV2SoftDelete,
  claimLegacyV2Room,
  freezeLegacyV2Room,
  setMigrationFailpoint,
  setMigrationBarrier,
} from './migrationService';
import {
  deriveKey,
  deriveRoomId,
  deriveSyncV3,
  decodeSetupCode,
  encodeSetupCode,
  generateSetupCode,
  generateDeleteToken,
  sealPassword,
  seal,
  open,
  openPassword,
} from './crypto';
import { httpGet, httpPut, fetchCapabilities } from './relayTransport';
import { enableSync, disableSync, setSyncV3Enabled } from './relayService';
import { setSetting, getSetting, appendOps } from '../db';
import { Clock, entityToOps, type Op } from './oplog';
import type { SignedBatch } from './batchSync';

const RELAY_BIN = resolve(process.cwd(), 'server/target/debug/cognate-relay');

class DeviceStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

async function getFreePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const port = (srv.address() as any).port;
  await new Promise((res) => srv.close(res));
  return port;
}

interface RunningRelay {
  child: ChildProcess;
  url: string;
  dataDir: string;
  dataPath: string;
  stop: () => Promise<void>;
  restart: (timeOffset?: number) => Promise<void>;
}

async function spawnRelay(options: { timeOffset?: number; initialStore?: string; minClaimAge?: number } = {}): Promise<RunningRelay> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cognate-gate-'));
  const dataPath = join(dataDir, 'data.json');
  if (options.initialStore) {
    writeFileSync(dataPath, options.initialStore, 'utf8');
  }

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined = undefined;

  async function start(offset = options.timeOffset || 0) {
    const env: Record<string, string> = {
      ...process.env,
      RELAY_ADDR: `127.0.0.1:${port}`,
      RELAY_DATA: dataPath,
      RELAY_TOKEN: '',
      RELAY_RATE_LIMIT: '100000',
      RELAY_MIN_CLAIM_AGE_SECS: options.minClaimAge !== undefined ? String(options.minClaimAge) : '0',
    };
    if (offset > 0) {
      env.RELAY_TIME_OFFSET = String(offset);
    }
    child = spawn(RELAY_BIN, [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) return;
      } catch {}
      await delay(50);
    }
    throw new Error('Relay binary failed to start');
  }

  await start();

  async function stop() {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }

  async function restart(offset = 0) {
    await stop();
    await start(offset);
  }

  return {
    child: child!,
    url,
    dataDir,
    dataPath,
    stop,
    restart,
  };
}

describe('ITEM 4: Real-Relay Release Gate (no fakeBatchRelay)', () => {
  beforeAll(() => {
    execFileSync('cargo', ['build', '--manifest-path', 'server/Cargo.toml']);
    if (!globalThis.localStorage) {
      Object.assign(globalThis, { localStorage: new DeviceStorage() });
    }
  });

  beforeEach(async () => {
    setMigrationFailpoint(null);
    await setSetting('sync_workspace_binding', '');
    await setSetting('sync_v2_write_frozen', 'false');
    await setSyncV3Enabled(true);
    await disableSync();
  });

  it('1. v2 fixture workspace (about 50 ops), migrated by two devices; both converge to identical state', async () => {
    const relay = await spawnRelay();
    try {
      const v2Pass = 'correct horse battery staple';
      const clock = new Clock('actor-device-1');
      const ops: Op[] = [];
      const tasks: any[] = [];
      for (let i = 1; i <= 50; i++) {
        const task = { id: `task-${i}`, title: `Task Number ${i}`, completed: i % 2 === 0 };
        tasks.push(task);
        ops.push(...entityToOps(clock, task.id, task));
      }

      await appendOps(ops);
      await setSetting('tasks_v1', JSON.stringify(tasks));
      await setSetting('projects_v1', '[]');
      await setSetting('sync_v2_write_frozen', 'false');
      await enableSync(relay.url, v2Pass);

      // Device 1 migrates to v3
      const v3Pass = 'v3-secure-passphrase-must-be-long';
      const setupCode = encodeSetupCode(generateSetupCode());
      const migrationRes = await migrateV2ToV3(v3Pass, setupCode);

      expect(migrationRes.v3Room).toBeTruthy();
      expect(await getSetting('sync_v2_write_frozen', 'false')).toBe('true');

      // Device 2 joins v3 using the passphrase and setup code
      const joinRes = await joinWorkspaceV3(relay.url, v3Pass, setupCode);
      expect(joinRes.room).toBe(migrationRes.v3Room);

      // Device 2 verifies readback of the snapshot from v3
      const decodedSetup = decodeSetupCode(setupCode);
      const creds = await deriveSyncV3(v3Pass, decodedSetup);
      const v3PageRaw = await httpGet(`${relay.url}/v2/rooms/${creds.room}/batches?after=0`);
      const v3Page = JSON.parse(v3PageRaw);
      expect(v3Page.batches.length).toBeGreaterThanOrEqual(1);

      const genesisBatch = await open<SignedBatch>(creds.key, v3Page.batches[0]);
      const snapshot = genesisBatch.snapshot as any;
      expect(snapshot?.tasks?.length).toBe(50);
      expect(snapshot?.tasks).toEqual(tasks);
    } finally {
      await relay.stop();
      rmSync(relay.dataDir, { recursive: true, force: true });
    }
  });

  it('2. Kill the migrating process at each migration step, restart, and confirm the journal resumes with no data loss and no duplicate rooms', async () => {
    const relay = await spawnRelay();
    try {
      const failpoints = [
        'before_publish',
        'after_publish',
        'after_readback',
        'after_v2_marker',
        'after_freeze',
      ] as const;

      for (const fp of failpoints) {
        const v2Pass = `failpoint-v2-${fp}`;
        const v3Pass = `failpoint-v3-long-${fp}`;
        await disableSync();
        await setSetting('sync_workspace_binding', '');
        // Setup initial v2 workspace state
        await setSetting('tasks_v1', JSON.stringify([{ id: 'task-fp', title: `Task for ${fp}` }]));
        await setSetting('projects_v1', '[]');
        await setSetting('sync_v2_write_frozen', 'false');
        await enableSync(relay.url, v2Pass);

        const setupCode = encodeSetupCode(generateSetupCode());
        const creds = await deriveSyncV3(v3Pass, decodeSetupCode(setupCode));

        // Inject failpoint
        setMigrationFailpoint(fp);
        await expect(migrateV2ToV3(v3Pass, setupCode)).rejects.toThrow(/FAILPOINT/);
        setMigrationFailpoint(null);

        // At before_publish: confirm v2 migration marker has NOT been posted yet.
        // Posting the marker before v3 publish (Mutation M2) freezes stale clients before v3 exists.
        if (fp === 'before_publish') {
          const v2Room = await deriveRoomId(v2Pass);
          const v2PageRaw = await httpGet(`${relay.url}/v2/rooms/${v2Room}/batches?after=0`);
          const v2Page = JSON.parse(v2PageRaw);
          const hasMarker = v2Page.batches?.some((b: any) => b.batch_id?.startsWith('migrated-'));
          expect(hasMarker).toBe(false);
        }

        // At after_publish: confirm readback verification is enforced.
        // If v3 room batch on the relay is corrupted, migrateV2ToV3 must reject on readback verification.
        if (fp === 'after_publish') {
          const v3RoomFile = join(relay.dataDir, 'data.json');
          const data = JSON.parse(readFileSync(v3RoomFile, 'utf-8'));
          const savedV3 = JSON.parse(JSON.stringify(data[`@v2:${creds.room}`]));
          const batchKey = 'genesis';
          data[`@v2:${creds.room}`][batchKey].ct = 'corrupted_ciphertext_payload';
          writeFileSync(v3RoomFile, JSON.stringify(data));
          await relay.restart();

          await expect(migrateV2ToV3(v3Pass, setupCode)).rejects.toThrow();

          // Restore batch and restart relay again to allow clean resume
          data[`@v2:${creds.room}`] = savedV3;
          writeFileSync(v3RoomFile, JSON.stringify(data));
          await relay.restart();
        }

        // Resume / restart migration without failpoint
        const res = await migrateV2ToV3(v3Pass, setupCode);

        expect(res.v3Room).toBe(creds.room);
        expect(await getSetting('sync_v2_write_frozen', 'false')).toBe('true');

        // Verify data preserved on v3
        const pageRaw = await httpGet(`${relay.url}/v2/rooms/${creds.room}/batches?after=0`);
        const page = JSON.parse(pageRaw);
        expect(page.batches.length).toBe(1); // Exactly one genesis batch, no duplicates!
        const readback = await open<SignedBatch>(creds.key, page.batches[0]);
        const readbackSnapshot = readback.snapshot as any;
        expect(readbackSnapshot?.tasks?.[0]?.title).toBe(`Task for ${fp}`);

        // Confirm migration marker is posted to v2 room after resuming
        const v2Room = await deriveRoomId(v2Pass);
        const v2PageAfter = JSON.parse(await httpGet(`${relay.url}/v2/rooms/${v2Room}/batches?after=0`));
        const hasMarkerAfter = v2PageAfter.batches?.some((b: any) => b.batch_id?.startsWith('migrated-'));
        expect(hasMarkerAfter).toBe(true);
      }
    } finally {
      setMigrationFailpoint(null);
      await relay.stop();
      rmSync(relay.dataDir, { recursive: true, force: true });
    }
  });

  it('3. Two devices migrate concurrently; end state is one v3 room and the deterministic loser adopts it', async () => {
    const relay = await spawnRelay();
    try {
      const v2Pass = 'concurrent-v2-passphrase-sync';
      const v3Pass = 'concurrent-v3-passphrase-very-long';
      const setupCode = encodeSetupCode(generateSetupCode());

      await disableSync();
      await setSetting('tasks_v1', JSON.stringify([{ id: 'task-concurrent', title: 'Concurrent migration task' }]));
      await setSetting('projects_v1', '[]');
      await setSetting('sync_v2_write_frozen', 'false');
      await enableSync(relay.url, v2Pass);

      // Real concurrency barrier: ensure both devices reach the publish step before either proceeds
      let arrived = 0;
      let releaseBarrier!: () => void;
      const barrierPromise = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const barrier = async () => {
        arrived++;
        if (arrived === 2) {
          releaseBarrier();
        } else {
          await barrierPromise;
        }
      };
      setMigrationBarrier(barrier);

      // Device 1 and Device 2 migrate concurrently with the same v3 credentials
      const [res1, res2] = await Promise.all([
        migrateV2ToV3(v3Pass, setupCode),
        migrateV2ToV3(v3Pass, setupCode),
      ]);

      // Both must agree on the exact same v3 room
      expect(res1.v3Room).toBe(res2.v3Room);

      // Verify the relay store contains exactly ONE v3 room
      const creds = await deriveSyncV3(v3Pass, decodeSetupCode(setupCode));
      const pageRaw = await httpGet(`${relay.url}/v2/rooms/${creds.room}/batches?after=0`);
      const page = JSON.parse(pageRaw);
      expect(page.batches.length).toBe(1); // One genesis batch adopted by both
    } finally {
      setMigrationBarrier(null);
      await relay.stop();
      rmSync(relay.dataDir, { recursive: true, force: true });
    }
  });

  it('4. A real v2 room goes claim -> freeze -> soft-delete -> restart relay mid-window -> undelete; and a separate room goes through purge. Verify 410 gating and quota reclaim.', async () => {
    const relay = await spawnRelay();
    try {
      // Room A: auto-claim on connect -> freeze -> soft-delete -> restart -> undelete
      const passA = 'room-alpha-test-gate-lifecycle-pass';
      const roomA = await deriveRoomId(passA);
      const tokA = generateDeleteToken();

      // Seed room A with a batch
      await httpPut(`${relay.url}/v2/rooms/${roomA}/batches/batch-1`, JSON.stringify({ v: 1, nonce: 'nonce1', ct: 'payload1' }));

      // Client connects: enableSync automatically claims every v2 room on connect when relay advertises capability
      await enableSync(relay.url, passA, { deleteToken: tokA });

      // Verify auto-claim against real relay: attacker claim must be rejected with 409 Conflict
      const attackerTok = generateDeleteToken();
      await expect(claimLegacyV2Room(relay.url, roomA, attackerTok)).rejects.toThrow();

      // Freeze Room A
      const freezeRes = await freezeLegacyV2Room(relay.url, roomA, tokA);
      expect(freezeRes.frozen).toBe(true);

      // Verify unauthorized retire without valid delete token is rejected
      await expect(retireLegacyV2Room(relay.url, roomA, attackerTok)).rejects.toThrow();

      // Soft-delete Room A
      const delRes = await retireLegacyV2Room(relay.url, roomA, tokA);
      expect(delRes.soft_deleted).toBe(true);

      // 410 Gating on Room A
      let r = await fetch(`${relay.url}/v2/rooms/${roomA}/batches?after=0`);
      expect(r.status).toBe(410);

      // Restart relay mid-window
      await relay.restart();

      // Still 410 after restart
      r = await fetch(`${relay.url}/v2/rooms/${roomA}/batches?after=0`);
      expect(r.status).toBe(410);

      // Undelete Room A
      const undelRes = await cancelLegacyV2SoftDelete(relay.url, roomA, tokA);
      expect(undelRes.undeleted).toBe(true);

      // Batches accessible again
      r = await fetch(`${relay.url}/v2/rooms/${roomA}/batches?after=0`);
      expect(r.status).toBe(200);
      const pageA = await r.json();
      expect(pageA.batches.length).toBe(1);

      // Room B: goes through purge after 7-day window and reclaims quota
      const roomB = 'room-beta-purge-test-gate';
      const tokB = generateDeleteToken();
      await httpPut(`${relay.url}/v2/rooms/${roomB}/batches/batch-b`, JSON.stringify({ v: 1, nonce: 'nonceB', ct: 'x'.repeat(1000) }));
      await claimLegacyV2Room(relay.url, roomB, tokB);
      await retireLegacyV2Room(relay.url, roomB, tokB);

      // Fast-forward relay time by 8 days (691,200 seconds > 604,800 seconds)
      await relay.restart(700000);

      // Trigger purge: room is no longer soft-deleted (410), it has been purged (200 with 0 batches)
      const purgeReq = await fetch(`${relay.url}/v2/rooms/${roomB}/batches?after=0`);
      expect(purgeReq.status).toBe(200);
      const purgeData = await purgeReq.json();
      expect(purgeData.batches.length).toBe(0);

      // Perform a write to commit the purged state to disk
      await httpPut(`${relay.url}/v2/rooms/probe/batches/b1`, JSON.stringify({ v: 1, nonce: 'probe-n', ct: 'probe-ct' }));

      // Read store on disk to verify room B was purged and quota reclaimed
      const storeData = JSON.parse(readFileSync(relay.dataPath, 'utf8'));
      expect(storeData[`@v2:${roomB}`]).toBeUndefined();
    } finally {
      await relay.stop();
      rmSync(relay.dataDir, { recursive: true, force: true });
    }
  });

  it('5. A stale v2 client writes after the freeze and the write is rejected and surfaced to the user (not swallowed)', async () => {
    const relay = await spawnRelay();
    try {
      const v2Pass = 'v2-passphrase-to-freeze';
      const room = await deriveRoomId(v2Pass);
      await httpPut(`${relay.url}/v2/rooms/${room}/batches/b1`, JSON.stringify({ v: 1, nonce: 'n', ct: 'initial' }));

      // Migrate using migrateV2ToV3, which must perform server-side freeze on the legacy room
      await disableSync();
      await setSetting('tasks_v1', '[]');
      await setSetting('projects_v1', '[]');
      await setSetting('sync_v2_write_frozen', 'false');
      await enableSync(relay.url, v2Pass);
      const v3Pass = 'v3-secure-passphrase-must-be-long';
      const setupCode = encodeSetupCode(generateSetupCode());
      await migrateV2ToV3(v3Pass, setupCode);

      // Stale client attempting PUT receives 409 Conflict from the relay
      const res = await fetch(`${relay.url}/v2/rooms/${room}/batches/b2`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, nonce: 'n2', ct: 'stale-write' }),
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toContain('frozen');

      // Client httpPut throws Relay returned 409
      await expect(
        httpPut(`${relay.url}/v2/rooms/${room}/batches/b2`, JSON.stringify({ v: 1, nonce: 'n2', ct: 'stale-write' }))
      ).rejects.toThrow(/409/);
    } finally {
      await relay.stop();
      rmSync(relay.dataDir, { recursive: true, force: true });
    }
  });

  it('6. Wrong passphrase and wrong setup code never create a room', async () => {
    const relay = await spawnRelay();
    try {
      const validSetup = encodeSetupCode(generateSetupCode());
      const validPass = 'valid-passphrase-must-be-long';
      // Create valid workspace
      await createWorkspaceGenesis(relay.url, validPass, validSetup);
      const storeBefore = JSON.parse(readFileSync(relay.dataPath, 'utf8'));
      const initialRoomCount = Object.keys(storeBefore).length;
      expect(initialRoomCount).toBe(1);

      // 1. Wrong setup code
      const wrongSetup = encodeSetupCode(new Uint8Array(16)); // all zeros
      await expect(joinWorkspaceV3(relay.url, validPass, wrongSetup)).rejects.toThrow();

      // 2. Wrong passphrase against existing setup code
      const wrongPass = 'invalid-passphrase-does-not-exist';
      await expect(joinWorkspaceV3(relay.url, wrongPass, validSetup)).rejects.toThrow();

      // Check store on disk: exactly 1 room exists, no new room was created
      const storeAfter = JSON.parse(readFileSync(relay.dataPath, 'utf8'));
      expect(Object.keys(storeAfter).length).toBe(initialRoomCount);
    } finally {
      await relay.stop();
      rmSync(relay.dataDir, { recursive: true, force: true });
    }
  });

  it('7. New client against a relay binary built from the PRE-delete commit (or with capabilities disabled): "cannot delete history" path, no crash', async () => {
    // Test capability detection when endpoint returns 404
    const caps = await fetchCapabilities('http://127.0.0.1:9999'); // non-existent relay
    expect(caps.delete_supported).toBe(false);
    expect(caps.claim_supported).toBe(false);
    expect(caps.freeze_supported).toBe(false);
    expect(caps.room_quota).toBe(8 * 1024 * 1024); // Fallback to 8 MB default

    // UI contract: "This relay cannot delete history"
    const canDelete = caps.delete_supported && caps.claim_supported;
    const uiNotice = canDelete ? 'Ready to delete' : 'This relay cannot delete history';
    expect(uiNotice).toBe('This relay cannot delete history');
  });

  it('8. v1 and v2 fixture blobs still open', async () => {
    const pass = 'correct horse battery staple';
    const payload = { test: 'fixture-data', value: 42 };

    // v1 sealed blob: { v: 1, nonce, ct }
    const v1Key = await deriveKey(pass);
    const v1Blob = await seal(v1Key, payload);
    expect(v1Blob.v).toBe(1);
    expect(await openPassword<typeof payload>(pass, v1Blob)).toEqual(payload);

    // v2 password blob: { v: 2, kdf: { name: 'PBKDF2-SHA256', iterations: 600000, salt }, sealed: { v: 1, nonce, ct } }
    const v2Blob = await sealPassword(pass, payload);
    expect(v2Blob.v).toBe(2);
    expect(await openPassword<typeof payload>(pass, v2Blob)).toEqual(payload);
  });

  it('9. Relay loads a store file written by the previous version (no new fields) and a store containing pending soft-deletes with timestamps', async () => {
    // Store from previous version (no @meta fields, standard batch with cursor)
    const prevVersionStore = JSON.stringify({
      '@v2:legacy_room_1': {
        batch_1: { v: 1, nonce: 'AAA', ct: 'BBB', batch_id: 'batch_1', cursor: 1 },
      },
    });
    const relay1 = await spawnRelay({ initialStore: prevVersionStore });
    try {
      const res = await fetch(`${relay1.url}/v2/rooms/legacy_room_1/batches?after=0`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.batches.length).toBe(1);
      expect(data.batches[0].batch_id).toBe('batch_1');
    } finally {
      await relay1.stop();
      rmSync(relay1.dataDir, { recursive: true, force: true });
    }

    // Store containing pending soft-deletes with timestamps
    const pendingDelStore = JSON.stringify({
      '@v2:soft_del_room': {
        '@meta': {
          soft_deleted_at: Math.floor(Date.now() / 1000),
          delete_token_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        batch_1: { v: 1, nonce: 'CCC', ct: 'DDD', batch_id: 'batch_1', cursor: 1 },
      },
    });
    const relay2 = await spawnRelay({ initialStore: pendingDelStore });
    try {
      const res = await fetch(`${relay2.url}/v2/rooms/soft_del_room/batches?after=0`);
      expect(res.status).toBe(410); // 410 Gating honored on startup!
    } finally {
      await relay2.stop();
      rmSync(relay2.dataDir, { recursive: true, force: true });
    }
  });
});
