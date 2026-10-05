# Cognate Sync Relay

A **dumb, end-to-end-encrypted** store-and-forward service for Cognate's sync.

It buckets sealed blobs by an opaque `room` id and a device `actor` id and hands
them back on request. It **never holds keys and cannot decrypt anything** — every
value it stores was sealed with AES-GCM on the client, and the CRDT merge that
makes edits converge happens on the clients. That's why it can stay this small.
The same service backs both single-user multi-device sync and shared (team)
projects — each share is just its own `room`, keyed by its own secret.

## API

```
PUT  /rooms/{room}/blobs/{actor}    body: sealed blob JSON   -> {"ok":true}
GET  /rooms/{room}/blobs            -> {"blobs":[{actor, v, nonce, ct}, ...]}
GET  /rooms/{room}/version          -> {"version": N}        # cheap change counter
GET  /rooms/{room}/poll?since=N     -> {"version": M}        # long-poll (real-time)
GET  /health                        -> {"ok":true}           # open, for probes
```

- `room` is derived client-side from the sync passphrase / share secret (the server
  only sees an opaque hex id). `nonce`/`ct` are the AES-GCM IV and ciphertext —
  opaque to the relay. A device overwrites only its own `{room}/{actor}` blob.
- **`version`** increments on every write to a room; clients poll it cheaply to know
  *whether* to do a full (decrypt + merge) sync.
- **`poll`** holds the request until the room's version moves past `since` (or a
  ~25s timeout), without websockets. Each held poll occupies a worker thread; poll admission
  reserves half the worker pool for ordinary requests. Delivery latency is unmeasured.

## Run

```sh
cargo run                            # listens on 127.0.0.1:8787 (open, in dev)
RELAY_ADDR=0.0.0.0:8787 cargo run    # bind elsewhere
RELAY_TOKEN=secret cargo run         # require Authorization: Bearer secret on /rooms/*
```

| Env var | Default | Purpose |
|---|---|---|
| `RELAY_ADDR` | `127.0.0.1:8787` | bind address |
| `RELAY_DATA` | `relay-data.json` | Synced JSON snapshot file (failed writes return 503) |
| `RELAY_TOKEN` | _(empty = open)_ | shared bearer token gating `/rooms/*` |
| `RELAY_RATE_LIMIT` / `RELAY_RATE_WINDOW` | `240` / `60` | per-IP fixed-window limit (→ 429) |
| `RELAY_WORKERS` | `16` | request worker threads (long-polls occupy workers) |

Then in Cognate → **Settings → Live sync**, set the Relay URL (e.g.
`http://127.0.0.1:8787`), a strong shared passphrase, and (if set) the access token.
Use the same passphrase on every device.

## Test

```sh
cargo test                 # routing, auth, rate limit, durability, versioning, long-poll
cargo clippy -- -D warnings
```

## Notes / production

- **Durability:** production PUT publishes a file-synced snapshot (with parent-directory sync on Unix) before acknowledgement. Failed persistence returns 503 without changing memory/version. Corrupt stored data fails startup. Helper-level unavailable-disk, quota and restart tests pass; actual disk-full, process-kill and sustained HTTP load fixtures remain required.
- **Auth:** set `RELAY_TOKEN` for a hosted/gated relay. It is **not** a decryption
  key — the relay still only ever sees ciphertext; it just stops anonymous strangers
  from filling your relay.
- **CORS** is open (`Access-Control-Allow-Origin: *`) so browser/PWA clients work; the
  desktop app routes through the Rust `relay_fetch` command instead.
- Because the server only ever sees ciphertext, the task contents are encrypted. Room/actor IDs, blob sizes, timing, and network
  metadata remain visible; encryption does not establish availability or freshness.

Track production blockers and acceptance criteria in [the roadmap](../docs/PRODUCTION_ROADMAP.md).

Storage is bounded: 1 MB request bodies, 32 MB serialized store, 1000 rooms, 128 actors per room. Corrupt/unreadable stores fail startup. Poll admission reserves half the request workers. See [deployment requirements](../docs/RELAY.md#deployment-requirements); HTTP load and crash/restart protocol validation remain open.

Protocol v2 provides immutable encrypted batch journals and durable restart-safe cursors. New clients require v2 and retain legacy local bundles for explicit migration. See [protocol, quotas, trust limits and TLS deployment requirements](../docs/RELAY.md). `/metrics` is bearer-gated when `RELAY_TOKEN` is configured. Journal compaction and staging slow-client/disk-full validation remain open.
