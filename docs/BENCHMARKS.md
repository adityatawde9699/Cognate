# Performance measurements

`npm run benchmark -- <path>` loads the production TypeScript planner, operation merge/materialization, task projection, and history serialization under Vite's SSR transform in Node. It runs two warmups and seven measured samples, checks output accounting, and records raw per-sample latency, CPU time, RSS, heap change, peak process RSS, runtime, hardware, Git revision, and working-tree state. This measures application logic in Node; it does not measure browser rendering, cold startup, or native SQLite.

`npm run benchmark:relay -- <path>` builds and runs the real release relay against 250 loopback HTTP uploads of 30 KB synthetic opaque payloads. It records request latency, relay and client CPU, relay peak RSS, then hard-kills and restarts the relay to verify page replay, duplicate acknowledgement, and collision rejection. It does not represent signed client convergence, a public network, or production traffic. CPU and RSS are recorded only on Linux.

The retained local reports are [Node baseline](../benchmarks/2026-10-11-node.json) and [relay baseline](../benchmarks/2026-10-11-relay.json). They were captured on Linux x64 with a 13th Gen Intel Core i7-13620H and 24.3 GB RAM. Both report the source revision and that the working tree was modified; this is a reproducible baseline for the implementation under review, not a clean-tag benchmark.

The Node report measured these medians and p95 latencies:

| Workload | Median | p95 |
| --- | ---: | ---: |
| Planner, 100 tasks | 0.1 ms | 0.1 ms |
| Planner, 1,000 tasks | 0.3 ms | 0.4 ms |
| Planner, 10,000 tasks | 3.2 ms | 4.7 ms |
| Merge, 50,000 operations | 303.2 ms | 310.4 ms |
| Materialize, 50,000 operations | 155.5 ms | 183.2 ms |
| Project 10,000 tasks from 50,000 operations | 156.3 ms | 178.6 ms |
| Serialize 50,000 operations | 36.8 ms | 40.9 ms |

The relay report measured 8.3 ms median and 14.2 ms p95 per 30 KB durable upload for 250 sequential local requests; the run took 2.10 seconds total and relay peak RSS was 151.4 MiB. These are local loopback measurements.

## Relay write-path scaling benchmarks

`node scripts/relay-scale-benchmark.mjs` measures durable write latency (`PUT /v2/rooms/.../batches/...`) across stores pre-populated to 5 MB, 15 MB, and 30 MB (approaching the 32 MB store limit).

Before optimization (Issue E), every write held the store mutex, cloned the store twice, serialized JSON twice, and held the global lock across `fsync`. After optimization, the write path performs at most one clone, one serialization, and releases the store lock before `fsync`, allowing concurrent reads.

| Pre-populated Store Size | Baseline Median | Baseline p95 | Optimized Median | Optimized p95 | Speedup (Median) |
|---|---:|---:|---:|---:|---:|
| 5 MB | 47.4 ms | 64.0 ms | 17.3 ms | 26.7 ms | 2.7x |
| 15 MB | 136.2 ms | 180.6 ms | 53.3 ms | 77.9 ms | 2.5x |
| 30 MB | 246.7 ms | 355.5 ms | 102.4 ms | 133.5 ms | 2.4x |

### Store write linearity & architectural scaling limits

Even with the single-clone/serialize optimization, because the relay serializes and fsyncs the entire `relay-data.json` store file on every durable write, the measured write latency is **approximately 3.5 ms per MB of total store size** (17.3 ms at 5 MB, 53.3 ms at 15 MB, 102.4 ms at 30 MB). Each write remains strictly linear ($O(N)$ with total store size) rather than proportional to the individual batch size.

**Proposals for sub-linear write scaling (proposals only; not implemented):**
1. **Append-Only Write-Ahead Journal (WAL)**: Each `PUT` appends the new batch JSON line directly to `journal.log` followed by `fsync` ($O(1)$ in batch size, $\approx 0.5\text{–}1\text{ ms}$ per write). An asynchronous background worker periodically compacts the journal into a base snapshot file without blocking the write path.
2. **Embedded SQLite Backing Store**: Replace single-file JSON persistence with SQLite in WAL mode (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`). Individual batch inserts are $O(1)$ indexed writes, allowing the relay to scale to gigabytes of ciphertext without per-write serialization or snapshot rewrite overhead.

CI uses generous provisional regression ceilings (p95 250 ms for each TypeScript planner size, 2.5 seconds for merge, 2 seconds for materialize/projection, 500 ms for serialization, and 1 second per local relay upload). They are regression alarms derived from this baseline, not user-facing performance promises or product acceptance targets. CI reports are retained as workflow artifacts. Benchmark results must be recaptured on stable hardware before making release claims.

Still unmeasured here: native Rust-vs-TypeScript timing and RSS, SQLite throughput/migration time, browser render/input latency, cold/warm application startup, large-history encryption/sync, slow-client and public-relay load, and mobile PWA performance. See [TESTING.md](TESTING.md) and the [production roadmap](PRODUCTION_ROADMAP.md).
