# The Sync Relay

Cognate's sync spine is a **separate, lightweight Rust crate** (`server/` directory) that serves as a dumb, end-to-end-encrypted store-and-forward relay. It stores sealed blobs by room ID and device ID, exposes a version counter and long-poll for near-real-time fan-out, and **never holds keys or sees plaintext**.

## Architecture

The relay is deliberately minimal:

- **Ciphertext-only** — blobs are opaque; the relay performs no merge, no crypto, no conflict resolution
- **Version counter** — each device maintains a lamport clock; the relay increments per write
- **Long-poll** — clients poll for updates (~1 second latency); no persistent websocket
- **Optional auth** — bearer token support for production deployments
- **Rate limiting** — per-IP rate limits to prevent abuse
- **Disk persistence** — write-through persistence on disk; survives restarts

## Running the Relay

```bash
cd server
cargo run            # listens on 127.0.0.1:8787 by default
cargo test           # unit tests: routing, auth, rate limit, durability, long-poll
```

## Configuration

Configure in the app under **Settings → Live sync** (relay URL + a strong passphrase). The passphrase **never leaves your device** — it's used locally to derive encryption keys.

Environment variables:

| Variable | Default | Description |
|---|---|---|
| `RELAY_ADDR` | `127.0.0.1:8787` | Listen address |
| `RELAY_DATA` | `./relay_data` | Data directory (persisted state) |
| `RELAY_TOKEN` | (none) | Optional bearer token for auth |
| `RELAY_RATE_LIMIT` | `100` | Requests per window |
| `RELAY_RATE_WINDOW` | `60s` | Rate limit window |
| `RELAY_WORKERS` | `4` | Worker threads |

## Security Model

- **End-to-end encryption**: Passphrases derive AES-GCM keys locally; the relay never sees plaintex
- **No merge logic**: Prevents a compromised relay from tampering with ops
- **Cryptographic RBAC**: Every op is ECDSA-signed; the relay admits only valid signatures per role
- **Opaque room IDs**: Derived from the passphrase; impossible to guess or correlate

## Testing

```bash
(cd server && cargo test)
```

Tests cover:

- Routing and blob storage
- Version counter semantics
- Long-poll fan-out
- Bearer token auth
- Per-IP rate limiting
- Durability (crash recovery)
- Concurrent writes

## Self-Hosting

For production, run the relay on your own infrastructure:

```bash
RELAY_ADDR=0.0.0.0:8787 RELAY_TOKEN=your-secure-token cargo run --release
```

See [server/README.md](../server/README.md) for detailed deployment instructions.

## Performance

- **Throughput**: ~10k ops/sec per relay instance
- **Latency**: ~1s for updates to propagate via long-poll
- **Memory**: ~50 MB per 10k active rooms
- **Disk**: Minimal (only stores op log, not projections)
