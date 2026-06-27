//! Cognate sync relay — a *dumb* end-to-end-encrypted store-and-forward service.
//!
//! It buckets sealed blobs by an opaque `room` id and a device `actor` id, and
//! hands them back on request. It never holds keys and cannot decrypt anything:
//! every value it stores was sealed (AES-GCM) on the client. The CRDT merge that
//! makes edits converge happens on the clients, not here — which is exactly why
//! the server can stay this small.
//!
//!   PUT  /rooms/{room}/blobs/{actor}   body = sealed blob JSON  -> {"ok":true}
//!   GET  /rooms/{room}/blobs           -> {"blobs":[{actor, ...sealed}]}
//!
//! Storage is per room -> per actor -> latest blob, kept in memory and
//! write-through-persisted to a JSON file (RELAY_DATA), so a restart doesn't
//! drop a team's shared docs. Still ciphertext-only; swap in a real KV store
//! for scale.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

/// room id -> (actor id -> latest sealed blob)
type Store = Mutex<HashMap<String, HashMap<String, Value>>>;
/// room id -> monotonic change counter, bumped on every write. Lets a client
/// cheaply poll "did anything change?" for near-real-time sync without a full
/// (decrypt + merge) round-trip each tick. In-memory; resets to 0 on restart,
/// which a client treats as "changed" and reconciles — safe by construction.
type Versions = Mutex<HashMap<String, u64>>;

/// Load the persisted store from disk, or start empty if absent/corrupt.
fn load_store(path: &str) -> HashMap<String, HashMap<String, Value>> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Write-through persist (temp file + rename, so a crash can't leave a half
/// file). Best-effort: a failed write never breaks request handling.
fn persist(store: &Store, path: &str) {
    if let Ok(guard) = store.lock() {
        if let Ok(json) = serde_json::to_string(&*guard) {
            let tmp = format!("{path}.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }
}

/// Convenience wrapper with a throwaway version map — keeps existing callers
/// and tests that don't care about versions unchanged.
pub fn route(store: &Store, method: &str, path: &str, body: &str) -> (u16, String) {
    let versions: Versions = Mutex::new(HashMap::new());
    route_v(store, &versions, method, path, body)
}

/// Pure request router — HTTP-framework-free so it is trivially testable.
/// Returns (status_code, json_body).
pub fn route_v(store: &Store, versions: &Versions, method: &str, path: &str, body: &str) -> (u16, String) {
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();

    match (method, parts.as_slice()) {
        // PUT /rooms/{room}/blobs/{actor}
        ("PUT", ["rooms", room, "blobs", actor]) => {
            let blob: Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, json!({"error": "body must be JSON"}).to_string()),
            };
            let mut s = store.lock().unwrap();
            s.entry((*room).to_string()).or_default().insert((*actor).to_string(), blob);
            *versions.lock().unwrap().entry((*room).to_string()).or_insert(0) += 1;
            (200, json!({"ok": true}).to_string())
        }
        // GET /rooms/{room}/blobs
        ("GET", ["rooms", room, "blobs"]) => {
            let s = store.lock().unwrap();
            let mut blobs: Vec<Value> = Vec::new();
            if let Some(room_blobs) = s.get(*room) {
                for (actor, blob) in room_blobs {
                    // Merge {actor} into the sealed object for the client.
                    let mut obj = blob.clone();
                    if let Some(map) = obj.as_object_mut() {
                        map.insert("actor".to_string(), json!(actor));
                    }
                    blobs.push(obj);
                }
            }
            (200, json!({ "blobs": blobs }).to_string())
        }
        // GET /rooms/{room}/version  → cheap change-counter for fast polling
        ("GET", ["rooms", room, "version"]) => {
            let v = versions.lock().unwrap().get(*room).copied().unwrap_or(0);
            (200, json!({ "version": v }).to_string())
        }
        ("GET", ["health"]) => (200, json!({"ok": true}).to_string()),
        _ => (404, json!({"error": "not found"}).to_string()),
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

// ── Bearer auth ──────────────────────────────────────────
// Optional shared-secret gate for hosting. When RELAY_TOKEN is set, every
// /rooms request must carry `Authorization: Bearer <token>`. The token is NOT
// a decryption key (the relay still can't read blobs); it just stops anonymous
// strangers from filling your relay. Empty token = open (dev/self-host default).

fn bearer_ok(headers: &[Header], expected: &str) -> bool {
    if expected.is_empty() {
        return true; // no token configured → open
    }
    let want = format!("Bearer {expected}");
    headers
        .iter()
        .any(|h| h.field.equiv("Authorization") && h.value.as_str().trim() == want)
}

// ── Rate limiting ────────────────────────────────────────
// Per-IP fixed window. Cheap defence against floods; tune via env.

struct Bucket {
    window_start: u64,
    count: u32,
}
type RateMap = Mutex<HashMap<String, Bucket>>;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Returns true if the request is allowed; counts it against the window.
fn rate_ok(rate: &RateMap, ip: &str, now: u64, limit: u32, window: u64) -> bool {
    let mut m = rate.lock().unwrap();
    let b = m.entry(ip.to_string()).or_insert(Bucket { window_start: now, count: 0 });
    if now.saturating_sub(b.window_start) >= window {
        b.window_start = now;
        b.count = 0;
    }
    b.count += 1;
    b.count <= limit
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

// ── Real-time long-poll (Act 3) ──────────────────────────
// A client GETs /rooms/{room}/poll?since=N and we hold the request until the
// room's version moves (someone wrote) or a timeout elapses, then return the
// current version. Near-instant fan-out without websockets. Each in-flight poll
// occupies one worker thread (see the pool in `main`).

const POLL_TIMEOUT: Duration = Duration::from_secs(25);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

fn current_version(versions: &Versions, room: &str) -> u64 {
    versions.lock().unwrap().get(room).copied().unwrap_or(0)
}

/// Parse `since=` out of a query string; defaults to 0.
fn parse_since(path: &str) -> u64 {
    path.split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("since="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Cooperatively wait until the room version differs from `since` or the
/// timeout elapses; returns the current version either way.
fn wait_for_change(versions: &Versions, room: &str, since: u64, timeout: Duration, interval: Duration) -> u64 {
    let start = Instant::now();
    loop {
        let v = current_version(versions, room);
        if v != since {
            return v;
        }
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            return v;
        }
        thread::sleep(interval.min(timeout - elapsed));
    }
}

fn cors_json(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
}

/// Immutable relay configuration shared across worker threads.
struct Config {
    data_path: String,
    token: String,
    rate_limit: u32,
    rate_window: u64,
}

/// Handle one request end-to-end (CORS, rate limit, auth, route). Runs on a
/// worker thread, so the blocking `poll` route only ties up that one thread.
fn serve(mut req: Request, store: &Store, versions: &Versions, rate: &RateMap, cfg: &Config) {
    let method = req.method().clone();
    let path = req.url().to_string();

    // CORS preflight.
    if method == Method::Options {
        let resp = Response::empty(204)
            .with_header(header("Access-Control-Allow-Origin", "*"))
            .with_header(header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS"))
            .with_header(header("Access-Control-Allow-Headers", "Content-Type, Authorization"));
        let _ = req.respond(resp);
        return;
    }

    // Rate limit by client IP (fixed window).
    let ip = req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "unknown".into());
    if !rate_ok(rate, &ip, now_secs(), cfg.rate_limit, cfg.rate_window) {
        let _ = req.respond(cors_json(429, json!({"error": "rate limited"}).to_string()));
        return;
    }

    // Auth gate (health stays open for probes).
    let is_health = path.split('?').next().unwrap_or("").trim_end_matches('/').ends_with("/health");
    if !is_health && !bearer_ok(req.headers(), &cfg.token) {
        let _ = req.respond(cors_json(401, json!({"error": "unauthorized"}).to_string()));
        return;
    }

    let mut body = String::new();
    let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);

    // The long-poll route blocks; handle it here so route_v stays pure/non-blocking.
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let (status, payload) = if let ("GET", ["rooms", room, "poll"]) = (method.as_str(), parts.as_slice()) {
        let v = wait_for_change(versions, room, parse_since(&path), POLL_TIMEOUT, POLL_INTERVAL);
        (200u16, json!({ "version": v }).to_string())
    } else {
        route_v(store, versions, method.as_str(), &path, &body)
    };

    if method == Method::Put && status == 200 {
        persist(store, &cfg.data_path);
    }
    let _ = req.respond(cors_json(status, payload));
}

fn main() {
    let addr = std::env::var("RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let data_path = std::env::var("RELAY_DATA").unwrap_or_else(|_| "relay-data.json".to_string());
    let token = std::env::var("RELAY_TOKEN").unwrap_or_default();
    let rate_limit = env_u32("RELAY_RATE_LIMIT", 240); // requests…
    let rate_window = env_u32("RELAY_RATE_WINDOW", 60) as u64; // …per this many seconds, per IP
    let workers = env_u32("RELAY_WORKERS", 16).max(1); // a pool so long-polls don't block others

    let server = Arc::new(Server::http(&addr).expect("failed to bind relay address"));
    let store: Arc<Store> = Arc::new(Mutex::new(load_store(&data_path)));
    let versions: Arc<Versions> = Arc::new(Mutex::new(HashMap::new()));
    let rate: Arc<RateMap> = Arc::new(Mutex::new(HashMap::new()));
    let open = token.is_empty();
    let cfg = Arc::new(Config { data_path, token, rate_limit, rate_window });
    println!(
        "Cognate relay (E2E, ciphertext-only) on http://{addr} (data: {}, auth: {}, limit: {rate_limit}/{rate_window}s, workers: {workers})",
        cfg.data_path,
        if open { "open" } else { "token" }
    );

    let mut handles = Vec::new();
    for _ in 0..workers {
        let server = Arc::clone(&server);
        let store = Arc::clone(&store);
        let versions = Arc::clone(&versions);
        let rate = Arc::clone(&rate);
        let cfg = Arc::clone(&cfg);
        handles.push(thread::spawn(move || {
            while let Ok(req) = server.recv() {
                serve(req, &store, &versions, &rate, &cfg);
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty() -> Store { Mutex::new(HashMap::new()) }

    #[test]
    fn put_then_get_returns_the_blob_with_its_actor() {
        let s = empty();
        let (code, _) = route(&s, "PUT", "/rooms/r1/blobs/deviceA", r#"{"v":1,"nonce":"n","ct":"c"}"#);
        assert_eq!(code, 200);

        let (code, body) = route(&s, "GET", "/rooms/r1/blobs", "");
        assert_eq!(code, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        let blobs = v["blobs"].as_array().unwrap();
        assert_eq!(blobs.len(), 1);
        assert_eq!(blobs[0]["actor"], "deviceA");
        assert_eq!(blobs[0]["ct"], "c");
    }

    #[test]
    fn a_device_overwrites_only_its_own_blob() {
        let s = empty();
        route(&s, "PUT", "/rooms/r1/blobs/A", r#"{"v":1,"nonce":"n1","ct":"old"}"#);
        route(&s, "PUT", "/rooms/r1/blobs/B", r#"{"v":1,"nonce":"n2","ct":"bbb"}"#);
        route(&s, "PUT", "/rooms/r1/blobs/A", r#"{"v":1,"nonce":"n3","ct":"new"}"#);

        let (_, body) = route(&s, "GET", "/rooms/r1/blobs", "");
        let v: Value = serde_json::from_str(&body).unwrap();
        let blobs = v["blobs"].as_array().unwrap();
        assert_eq!(blobs.len(), 2); // A and B, not three
        let a = blobs.iter().find(|b| b["actor"] == "A").unwrap();
        assert_eq!(a["ct"], "new"); // A's blob was replaced, not duplicated
    }

    #[test]
    fn rooms_are_isolated() {
        let s = empty();
        route(&s, "PUT", "/rooms/r1/blobs/A", r#"{"v":1,"nonce":"n","ct":"r1"}"#);
        let (_, body) = route(&s, "GET", "/rooms/r2/blobs", "");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["blobs"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn rejects_non_json_body_and_unknown_routes() {
        let s = empty();
        assert_eq!(route(&s, "PUT", "/rooms/r1/blobs/A", "not json").0, 400);
        assert_eq!(route(&s, "GET", "/nope", "").0, 404);
    }

    #[test]
    fn bearer_auth_open_when_no_token_else_requires_match() {
        assert!(bearer_ok(&[], "")); // open when unconfigured
        let h = vec![Header::from_bytes(&b"Authorization"[..], &b"Bearer s3cret"[..]).unwrap()];
        assert!(bearer_ok(&h, "s3cret"));
        assert!(!bearer_ok(&h, "other")); // wrong token
        assert!(!bearer_ok(&[], "s3cret")); // missing header when token required
    }

    #[test]
    fn rate_limit_blocks_after_threshold_then_resets_per_window_and_ip() {
        let r: RateMap = Mutex::new(HashMap::new());
        for _ in 0..3 {
            assert!(rate_ok(&r, "1.2.3.4", 100, 3, 60));
        }
        assert!(!rate_ok(&r, "1.2.3.4", 100, 3, 60)); // 4th in-window → blocked
        assert!(rate_ok(&r, "1.2.3.4", 200, 3, 60)); // next window → allowed
        assert!(rate_ok(&r, "9.9.9.9", 100, 3, 60)); // a different IP is independent
    }

    #[test]
    fn version_counter_bumps_on_write_and_is_per_room() {
        let s = empty();
        let v: Versions = Mutex::new(HashMap::new());
        let ver = |room: &str| {
            let (_, body) = route_v(&s, &v, "GET", &format!("/rooms/{room}/version"), "");
            serde_json::from_str::<Value>(&body).unwrap()["version"].as_u64().unwrap()
        };
        assert_eq!(ver("r1"), 0); // nothing written yet
        route_v(&s, &v, "PUT", "/rooms/r1/blobs/A", r#"{"v":1,"nonce":"n","ct":"c"}"#);
        route_v(&s, &v, "PUT", "/rooms/r1/blobs/A", r#"{"v":1,"nonce":"n2","ct":"c2"}"#);
        assert_eq!(ver("r1"), 2); // two writes
        assert_eq!(ver("r2"), 0); // a different room is independent
    }

    #[test]
    fn parses_the_since_query_param() {
        assert_eq!(parse_since("/rooms/r/poll?since=5"), 5);
        assert_eq!(parse_since("/rooms/r/poll?foo=1&since=42"), 42);
        assert_eq!(parse_since("/rooms/r/poll"), 0);
        assert_eq!(parse_since("/rooms/r/poll?since=bad"), 0);
    }

    #[test]
    fn long_poll_returns_immediately_when_already_changed_else_times_out() {
        let v: Versions = Mutex::new(HashMap::new());
        // A write already happened (version 3) and the client last saw 0.
        v.lock().unwrap().insert("r1".to_string(), 3);
        let got = wait_for_change(&v, "r1", 0, Duration::from_secs(5), Duration::from_millis(10));
        assert_eq!(got, 3); // returns at once, no waiting

        // No change since version 3 → returns 3 after a short timeout.
        let start = Instant::now();
        let same = wait_for_change(&v, "r1", 3, Duration::from_millis(60), Duration::from_millis(10));
        assert_eq!(same, 3);
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn persists_and_reloads_across_restart() {
        let path = std::env::temp_dir().join(format!("cognate-relay-test-{}.json", std::process::id()));
        let p = path.to_str().unwrap();
        let _ = std::fs::remove_file(p);

        // First "process": store a blob and persist.
        let s1 = empty();
        route(&s1, "PUT", "/rooms/r1/blobs/A", r#"{"v":1,"nonce":"n","ct":"c"}"#);
        persist(&s1, p);

        // Second "process": load from disk — the blob survives.
        let s2: Store = Mutex::new(load_store(p));
        let (_, body) = route(&s2, "GET", "/rooms/r1/blobs", "");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["blobs"].as_array().unwrap().len(), 1);
        assert_eq!(v["blobs"][0]["ct"], "c");

        let _ = std::fs::remove_file(p);
    }
}
