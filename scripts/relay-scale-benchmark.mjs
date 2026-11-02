import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';

const executable = resolve(process.env.COGNATE_RELAY_BINARY || 'server/target/release/cognate-relay');

async function getAvailablePort() {
  const allocator = createServer();
  allocator.listen(0, '127.0.0.1');
  await once(allocator, 'listening');
  const port = allocator.address().port;
  await new Promise(res => allocator.close(res));
  return port;
}

function generateStoreFile(filePath, targetBytes) {
  // Create rooms with batches, each ~500 KB, until total size reaches targetBytes
  const store = {};
  let currentBytes = 2; // "{}"
  let roomIndex = 0;
  let batchIndex = 0;

  const payloadSize = 50 * 1024; // 50 KB per batch
  const payload = 'x'.repeat(payloadSize);

  while (currentBytes < targetBytes) {
    const roomKey = `@v2:seed_room_${roomIndex}`;
    if (!store[roomKey]) store[roomKey] = {};

    const batchKey = `batch_${batchIndex}`;
    store[roomKey][batchKey] = {
      v: 1,
      nonce: 'seed-nonce-1234',
      ct: payload,
      cursor: batchIndex + 1,
      batch_id: batchKey,
    };
    currentBytes += payloadSize + 100;
    batchIndex++;
    if (batchIndex >= 80) { // ~4 MB per room, well under 8 MB room quota
      roomIndex++;
      batchIndex = 0;
    }
  }

  const json = JSON.stringify(store);
  writeFileSync(filePath, json, 'utf8');
  return Buffer.byteLength(json, 'utf8');
}

async function runBenchmarkForSize(sizeMB) {
  const targetBytes = sizeMB * 1024 * 1024;
  const folder = mkdtempSync(join(tmpdir(), `relay-bench-${sizeMB}mb-`));
  const dataPath = join(folder, 'data.json');
  const actualBytes = generateStoreFile(dataPath, targetBytes);

  const port = await getAvailablePort();
  const url = `http://127.0.0.1:${port}`;
  let child = spawn(executable, [], {
    env: {
      ...process.env,
      RELAY_ADDR: `127.0.0.1:${port}`,
      RELAY_DATA: dataPath,
      RELAY_TOKEN: 'bench-token',
      RELAY_RATE_LIMIT: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const until = Date.now() + 10000;
    let ready = false;
    while (Date.now() < until) {
      try {
        const res = await fetch(`${url}/health`);
        if (res.ok) { ready = true; break; }
      } catch {}
      await delay(100);
    }
    if (!ready) throw new Error('Relay failed to start within 10s');

    const headers = {
      'Authorization': 'Bearer bench-token',
      'Content-Type': 'application/json',
    };
    const body = JSON.stringify({ v: 1, nonce: 'bench-nonce', ct: 'y'.repeat(10000) });

    const samples = [];
    const count = 20;
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      const res = await fetch(`${url}/v2/rooms/active_bench_room/batches/write_${i}`, {
        method: 'PUT',
        headers,
        body,
      });
      assert.equal(res.status, 200);
      samples.push(performance.now() - t0);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    return {
      sizeMB,
      actualMB: (actualBytes / (1024 * 1024)).toFixed(2),
      median_ms: median,
      p95_ms: p95,
      min_ms: sorted[0],
      max_ms: sorted[sorted.length - 1],
    };
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    try { rmSync(folder, { recursive: true, force: true }); } catch {}
  }
}

console.log('Measuring write latency at 5 MB, 15 MB, 30 MB store sizes...');
const results = [];
for (const size of [5, 15, 30]) {
  const res = await runBenchmarkForSize(size);
  results.push(res);
  console.log(`Store ~${res.sizeMB} MB: median ${res.median_ms.toFixed(2)} ms, p95 ${res.p95_ms.toFixed(2)} ms`);
}
console.log(JSON.stringify(results, null, 2));
