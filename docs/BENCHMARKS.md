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

CI uses generous provisional regression ceilings (p95 250 ms for each TypeScript planner size, 2.5 seconds for merge, 2 seconds for materialize/projection, 500 ms for serialization, and 1 second per local relay upload). They are regression alarms derived from this baseline, not user-facing performance promises or product acceptance targets. CI reports are retained as workflow artifacts. Benchmark results must be recaptured on stable hardware before making release claims.

Still unmeasured here: native Rust-vs-TypeScript timing and RSS, SQLite throughput/migration time, browser render/input latency, cold/warm application startup, large-history encryption/sync, slow-client and public-relay load, and mobile PWA performance. See [TESTING.md](TESTING.md) and the [production roadmap](PRODUCTION_ROADMAP.md).
