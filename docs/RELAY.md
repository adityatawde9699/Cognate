# The Sync Relay

The independent Rust crate in `server/` stores immutable v2 encrypted batches with durable cursors, while retaining legacy latest-blob rooms. Clients encrypt/decrypt and merge operations. The relay does not decrypt operations or verify shared-project signatures or roles.

## Run and configure

```bash
cd server
cargo run
cargo test
cargo clippy -- -D warnings
```

| Variable | Default | Purpose |
|---|---|---|
| `RELAY_ADDR` | `127.0.0.1:8787` | Listen address |
| `RELAY_DATA` | `relay-data.json` | JSON persistence file |
| `RELAY_TOKEN` | empty | Optional global bearer token for room endpoints |
| `RELAY_RATE_LIMIT` | `240` | Per-IP requests per fixed window |
| `RELAY_RATE_WINDOW` | `60` | Window seconds |
| `RELAY_WORKERS` | `16` | Request worker count |
| `RELAY_MAX_POLLS` | `workers / 2` (8) | Maximum concurrent long-poll slots |
| `RELAY_ROOM_QUOTA` | `8388608` (8 MB) | Per-room byte quota to prevent single-room exhaustion |
| `RELAY_TRUST_PROXY` | unset (false) | When set to `1` or `true`, rate limits by first `X-Forwarded-For` hop instead of socket IP |

Set the URL, passphrase, and optional access token in Settings → Live sync. See [server/README.md](../server/README.md) for endpoint details.

## Protocol v2

- `PUT /v2/rooms/{room}/batches/{batch_id}` accepts a sealed `{v:1,nonce,ct}` object. Success returns `{batch_id,cursor,durable:true}` only after file/parent sync. Retrying identical ciphertext returns the same acknowledgement; replacing a batch ID returns 409.
- `GET /v2/rooms/{room}/batches?after={cursor}` returns a contiguous page and its last cursor. Pages are bounded by 200 records and approximately 1 MB. Cursors are stored alongside ciphertext and survive relay restart.
- `/v2/rooms/{room}/version` returns the persisted current cursor non-blocking. `/poll` long-polls for updates until change or timeout, bounded by `RELAY_MAX_POLLS` (default `workers / 2`, 8 by default).
- `/metrics` exposes aggregate requests, durable writes, storage failures, active polls and record/room counts behind the configured bearer gate; it contains no room IDs or task data.

Clients verify ECDSA signatures over version, batch ID, actor/public key, context (workspace or share plus epoch) and operations. They pin actor keys, reject future clocks over five minutes ahead and retain failed pages without advancing cursors. Local raw operations are the durable outbox; a prepared sealed batch remains until its durable acknowledgement is saved. Acknowledgements/cursors are scoped to both relay endpoint and room. Automatic errors have persisted exponential backoff; rounds are bounded. Active workspace key/endpoint changes and reconnects of existing history under a different key are blocked pending an explicit signed-history migration. Three independent row/history store tests exercise outage, duplicate acknowledgement and reconnect.

Workspace passphrase possession grants device enrollment and read access. Existing keys are pinned; this is not a server-managed user account or per-device membership service. V2 key/room derivation uses PBKDF2-SHA256 with 600000 iterations and versioned labels. Portable recovery uses its own random salt. Shared invitations are owner-signed; revoked epochs freeze uploads in old clients after they receive the signed marker and require new invitations. A hostile relay can withhold data/markers; cryptography does not establish availability or global freshness.

Store quota is 32 MB, request quota 1 MB, at most 1000 stored rooms, 10000 v2 batches per room, per-room quota configurable via `RELAY_ROOM_QUOTA` (default 8 MB), and 128 legacy actors per room. Journals do not compact automatically; quota exhaustion fails explicitly. Legacy data is retained, but the new client does not silently ingest unsigned v1 live blobs. Export/import reviewed local operation bundles before moving old clients to v2. Signed v2 invitations must be minted by the original owner; old recovery kits restore capabilities only.

Tests include immutable cursors across restart, collisions, exact retry, quota admission, real HTTP persistence failure and saturated polls with health still available. Actual disk-full, slow uploads, process-kill durability and staging/public load remain required deployment evidence.

## Proposal: Monotonic v2 Journal Compaction & TTL (Design Only)

### Problem Statement
Currently, Protocol v2 batches in `server/src/main.rs` are immutable append-only records with no deletion mechanism. While the per-room byte quota (`RELAY_ROOM_QUOTA`, default 8 MB) prevents a single room from consuming the entire 32 MB store quota, active workspaces will eventually exhaust their room quota or hit the 10,000 batch limit unless older history can be compacted safely. Crucially, cursor identifiers must remain strictly monotonic so that clients polling with `?after={cursor}` never experience rewinds or missed updates.

### Proposed Architecture

1. **Monotonic Cursor Invariant**:
   - The relay assigns cursors sequentially: `1, 2, 3, ... N`.
   - Compacting batches `1..K` MUST NOT renumber subsequent batches `K+1..N`.
   - The room metadata tracks `watermark_cursor` (the highest cursor deleted) and `next_cursor` (the next cursor to allocate).
   - If a client requests `GET /v2/rooms/{room}/batches?after={cursor}` where `cursor < watermark_cursor`, the relay returns HTTP `410 Gone` with `{ "error": "history compacted", "watermark_cursor": K }` or returns the latest signed compaction checkpoint.

2. **Client-Driven Compaction Checkpoints**:
   - Because the relay is ciphertext-only and dumb, it cannot merge CRDT operations or compute application state snapshots.
   - Any client holding the full state can publish a special checkpoint batch:
     `PUT /v2/rooms/{room}/checkpoints/{checkpoint_id}`
     containing:
     - `compacts_up_to_cursor: K`
     - Signed snapshot of state at cursor `K`
   - The relay verifies that `K <= current_max_cursor` and stores the checkpoint.

3. **TTL and Pruning Policy**:
   - Environment variables:
     - `RELAY_BATCH_TTL`: Maximum age of raw batches before compaction eligibility (e.g., 30 days).
     - `RELAY_COMPACT_MIN_BATCHES`: Minimum batch count before pruning activates (e.g., 1,000).
   - Pruning only deletes individual batches `1..K` when:
     - A validated checkpoint covers up to cursor `K`, AND
     - The batch age exceeds `RELAY_BATCH_TTL`.
   - The room's watermark cursor is updated to `K`.

4. **Rollback & Safety Plan**:
   - Pruning is performed using the existing atomic write pattern (`write_tmp -> fsync -> rename -> fsync_parent`).
   - If an edge-case client is partitioned for longer than `RELAY_BATCH_TTL`, receiving `410 Gone` instructs the client to download the signed checkpoint at `watermark_cursor`, reset its local oplog projection, and resume incremental sync from `watermark_cursor`.

## Deployment requirements

Keep the relay bound to loopback behind a TLS reverse proxy (for example Nginx or Caddy). Configure a nonempty `RELAY_TOKEN` through a protected service environment file and an absolute `RELAY_DATA` path in a private directory. Keep the proxy request body limit at 1 MB and enforce connection/read timeouts and request concurrency there. Health probes use `/health`; all room endpoints require the configured bearer token. Back up the data file and exercise restore in staging before production use. TLS certificates, public DNS, service supervision, retained load results and multi-device outage tests require deployment-specific validation; none has been performed in this checkout.

Reviewed deployment templates are provided in [`server/deploy/nginx.conf`](../server/deploy/nginx.conf) and [`server/deploy/cognate-relay.service`](../server/deploy/cognate-relay.service). They buffer uploads at the TLS proxy, set body/header/upstream deadlines and connection limits, and run the relay as a dedicated service user with private state. Replace certificate paths/hostname, create the service account, and provide `RELAY_TOKEN` in a root-owned `/etc/cognate-relay.env` (mode 0600). Validate with `nginx -t` and staging load tests before enabling. These templates have not been deployed or validated against an installed Nginx/systemd instance here.
