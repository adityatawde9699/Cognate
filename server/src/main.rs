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

static REQUESTS:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
static DURABLE_WRITES:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
static STORAGE_FAILURES:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);

const MAX_BODY: usize = 1_048_576;
const MAX_STORE: usize = 32 * 1_048_576;
const MAX_ROOMS: usize = 1000;
const MAX_ACTORS: usize = 128;
/// Default per-room byte quota (8 MB). Configurable via RELAY_ROOM_QUOTA.
const DEFAULT_ROOM_QUOTA: usize = 8 * 1_048_576;
static ROOM_QUOTA: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(DEFAULT_ROOM_QUOTA);

thread_local! {
    static TEST_ROOM_QUOTA: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

fn room_quota() -> usize {
    TEST_ROOM_QUOTA.with(|c| c.get()).unwrap_or_else(|| {
        ROOM_QUOTA.load(std::sync::atomic::Ordering::Relaxed)
    })
}

#[cfg(test)]
fn set_room_quota_for_tests(quota: usize) {
    TEST_ROOM_QUOTA.with(|c| c.set(Some(quota)));
}

#[cfg(test)]
fn reset_room_quota_for_tests() {
    TEST_ROOM_QUOTA.with(|c| c.set(None));
}

fn room_bytes(room_data: &HashMap<String, Value>) -> usize {
    room_data.values().map(|v| serde_json::to_vec(v).map_or(0, |b| b.len())).sum()
}
type Data = HashMap<String,HashMap<String,Value>>;

/// Missing data starts empty; corruption/permission errors fail startup.
fn load_store(path: &str) -> Result<Data,String> {
    match std::fs::metadata(path) {
        Err(error) if error.kind()==std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.len()>MAX_STORE as u64 => return Err("Relay store exceeds quota".into()),
        _ => {},
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e|e.to_string())?).map_err(|e|e.to_string())
}

static WRITE_LOCK: Mutex<()> = Mutex::new(());
static PERSIST_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static TEST_FSYNC_DELAY: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn persist_bytes(json: &[u8], path: &str) -> Result<(),String> {
    #[cfg(test)]
    {
        let delay = TEST_FSYNC_DELAY.with(|c| c.get());
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
    }
    use std::io::Write;
    let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let tmp = format!("{path}.{}.{}.pending",std::process::id(),unique);
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp)?;
        file.write_all(json)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp,path)?;
        #[cfg(unix)] {
            let parent = std::path::Path::new(path).parent().filter(|p|!p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() {let _=std::fs::remove_file(&tmp);}
    result.map_err(|e|e.to_string())
}

#[cfg(test)]
fn persist_data(data: &Data, path: &str) -> Result<(),String> {
    let json = serde_json::to_vec(data).map_err(|e|e.to_string())?;
    if json.len()>MAX_STORE {return Err("Relay store quota exceeded".into());}
    persist_bytes(&json, path)
}
#[cfg(test)]
fn persist(store: &Store, path: &str) -> Result<(),String> {
    persist_data(&*store.lock().map_err(|e|e.to_string())?,path)
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len()<=128 && value.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-' || b==b'_')
}

/// Acknowledge only after the proposed snapshot has been synced and published.
/// Mutex is released during fsync to reduce contention.
fn durable_put(store: &Store, versions: &Versions, path: &str, body: &str, data_path: &str) -> (u16,String) {
    let _write_permit = WRITE_LOCK.lock().unwrap();

    let candidate_versions = Mutex::new(HashMap::new());
    let (candidate, response, json_bytes, next_gen) = {
        let guard = store.lock().unwrap();
        let candidate = Mutex::new(guard.clone());
        let response = route_v(&candidate, &candidate_versions, "PUT", path, body);
        if response.0 != 200 {
            return response;
        }
        let candidate = candidate.into_inner().unwrap();
        let json = match serde_json::to_vec(&candidate) {
            Ok(j) if j.len() <= MAX_STORE => j,
            Ok(_) => return (507, json!({"error": "store quota exceeded"}).to_string()),
            Err(e) => {
                STORAGE_FAILURES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return (503, json!({"error": format!("serialization failed: {e}"), "acknowledged": false}).to_string());
            }
        };
        let current_gen = PERSIST_GENERATION.load(std::sync::atomic::Ordering::SeqCst);
        (candidate, response, json, current_gen + 1)
    }; // store mutex dropped here before fsync

    if let Err(error) = persist_bytes(&json_bytes, data_path) {
        STORAGE_FAILURES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        eprintln!("Relay persistence failed: {error}");
        return (503, json!({"error": "durable storage unavailable; retry", "acknowledged": false}).to_string());
    }

    *store.lock().unwrap() = candidate;
    PERSIST_GENERATION.store(next_gen, std::sync::atomic::Ordering::SeqCst);
    DURABLE_WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    for (room, v) in candidate_versions.into_inner().unwrap() {
        if room.starts_with("@v2:") {
            versions.lock().unwrap().insert(room, v);
        } else {
            *versions.lock().unwrap().entry(room).or_insert(0) += v;
        }
    }
    response
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

    // V2 is an immutable, durable batch journal. Cursors live with ciphertext,
    // so restart never rewinds a client's incremental position.
    if parts.first()==Some(&"v2") {
        return batch_route(store,versions,method,path,body);
    }
    if parts.first()==Some(&"rooms") && (parts.len()<2 || !identifier(parts[1]) || (parts.len()==4 && !identifier(parts[3]))) {return (400,json!({"error":"invalid room or actor"}).to_string());}
    match (method, parts.as_slice()) {
        // PUT /rooms/{room}/blobs/{actor}
        ("PUT", ["rooms", room, "blobs", actor]) => {
            if body.len()>MAX_BODY {return (413,json!({"error":"blob exceeds 1 MB"}).to_string());}
            let blob: Value = match serde_json::from_str(body) {
                Ok(v) => v,
                Err(_) => return (400, json!({"error": "body must be JSON"}).to_string()),
            };
            if blob.get("v")!=Some(&json!(1)) || !blob.get("nonce").is_some_and(|v|v.as_str().is_some_and(|s|!s.is_empty() && s.len()<=256)) || !blob.get("ct").is_some_and(|v|v.as_str().is_some_and(|s|!s.is_empty())) {return (400,json!({"error":"invalid sealed blob"}).to_string());}
            let mut s = store.lock().unwrap();
            if (!s.contains_key(*room) && s.len()>=MAX_ROOMS) || s.get(*room).is_some_and(|actors|!actors.contains_key(*actor) && actors.len()>=MAX_ACTORS) {return (507,json!({"error":"room/actor quota exceeded"}).to_string());}
            let old = s.get(*room).and_then(|actors|actors.get(*actor)).cloned();
            if old.as_ref()==Some(&blob) {return (200,json!({"ok":true}).to_string());}
            let old_bytes = old.as_ref().map(|v| serde_json::to_vec(v).map_or(0, |b| b.len())).unwrap_or(0);
            let new_bytes = serde_json::to_vec(&blob).map_or(0, |b| b.len());
            let room_data = s.entry((*room).to_string()).or_default();
            if room_bytes(room_data) + new_bytes - old_bytes > room_quota() {
                return (507, json!({"error": "room quota exceeded"}).to_string());
            }
            room_data.insert((*actor).to_string(), blob);
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
        ("GET", ["health"]) => (200, json!({"ok": true,"protocol":2}).to_string()),
        _ => (404, json!({"error": "not found"}).to_string()),
    }
}

fn batch_route(store: &Store, versions: &Versions, method: &str, path: &str, body: &str) -> (u16,String) {
    let parts: Vec<_> = path.split('?').next().unwrap_or("").split('/').filter(|s|!s.is_empty()).collect();
    if parts.len()<4 || parts[1]!="rooms" || !["batches","version"].contains(&parts[3]) || !identifier(parts[2]) {
        return (400,json!({"error":"invalid batch path"}).to_string());
    }
    let room = format!("@v2:{}",parts[2]);
    let mut guard = store.lock().unwrap();
    if method=="GET" && parts.len()==4 && parts[3]=="version" {
        let version=guard.get(&room).map(|r|r.values().filter_map(|v|v["cursor"].as_u64()).max().unwrap_or(0)).unwrap_or(0);
        return (200,json!({"version":version}).to_string());
    }
    match (method,parts.len()) {
        ("PUT",5) if identifier(parts[4]) => {
            if body.len()>MAX_BODY {return (413,json!({"error":"batch exceeds 1 MB"}).to_string());}
            let mut blob: Value = match serde_json::from_str(body) {Ok(v)=>v,Err(_)=>return (400,json!({"error":"invalid JSON"}).to_string())};
            if blob.get("v")!=Some(&json!(1)) || !blob.get("nonce").is_some_and(|v|v.as_str().is_some_and(|s|!s.is_empty() && s.len()<=256)) || !blob.get("ct").is_some_and(|v|v.as_str().is_some_and(|s|!s.is_empty())) || blob.as_object().is_none_or(|m|m.len()!=3) {
                return (400,json!({"error":"invalid sealed batch"}).to_string());
            }
            if let Some(old)=guard.get(&room).and_then(|r|r.get(parts[4])) {
                if old["v"]!=blob["v"] || old["nonce"]!=blob["nonce"] || old["ct"]!=blob["ct"] {return (409,json!({"error":"batch id collision"}).to_string());}
                return (200,json!({"batch_id":parts[4],"cursor":old["cursor"],"durable":true}).to_string());
            }
            if (!guard.contains_key(&room) && guard.len()>=MAX_ROOMS) || guard.get(&room).is_some_and(|r|r.len()>=10000) {return (507,json!({"error":"batch journal quota exceeded"}).to_string());}
            let current_room_bytes = guard.get(&room).map(room_bytes).unwrap_or(0);
            let new_bytes = serde_json::to_vec(&blob).map_or(0, |b| b.len());
            if current_room_bytes + new_bytes > room_quota() {
                return (507, json!({"error": "room quota exceeded"}).to_string());
            }
            let cursor=guard.get(&room).map(|r|r.values().filter_map(|v|v["cursor"].as_u64()).max().unwrap_or(0)).unwrap_or(0)+1;
            blob["batch_id"]=json!(parts[4]); blob["cursor"]=json!(cursor);
            guard.entry(room.clone()).or_default().insert(parts[4].into(),blob);
            versions.lock().unwrap().insert(room, cursor);
            (200,json!({"batch_id":parts[4],"cursor":cursor,"durable":true}).to_string())
        },
        ("GET",4) => {
            let query=path.split_once('?').map(|(_,q)|q).unwrap_or("");
            let after=match query.split('&').find_map(|p|p.strip_prefix("after=")) {
                None=>0, Some(value)=>match value.parse::<u64>() {Ok(n)=>n,Err(_)=>return (400,json!({"error":"invalid cursor"}).to_string())}
            };
            let mut batches: Vec<Value>=guard.get(&room).map(|r|r.values().filter(|v|v["cursor"].as_u64().unwrap_or(0)>after).cloned().collect()).unwrap_or_default();
            batches.sort_by_key(|v|v["cursor"].as_u64().unwrap_or(0));
            // Bound the encrypted response by bytes as well as count.
            let mut size=0; let mut page=Vec::new();
            for batch in batches.into_iter().take(200) {
                let bytes=serde_json::to_vec(&batch).unwrap().len();
                if !page.is_empty() && size+bytes>MAX_BODY {break;}
                size+=bytes; page.push(batch);
            }
            let cursor=page.last().and_then(|v|v["cursor"].as_u64()).unwrap_or(after);
            (200,json!({"batches":page,"cursor":cursor}).to_string())
        },
        _=>(404,json!({"error":"unknown batch route"}).to_string())
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

use subtle::ConstantTimeEq;

/// Compare two byte slices in constant time to prevent timing attacks against tokens.
/// Note: timing guarantees cannot be unit-tested portably; the guarantee rests on the
/// subtle crate's ConstantTimeEq trait contract.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

fn bearer_ok(headers: &[Header], expected: &str) -> bool {
    if expected.is_empty() {
        return true; // no token configured → open
    }
    let want = format!("Bearer {expected}");
    headers
        .iter()
        .any(|h| h.field.equiv("Authorization") && constant_time_eq(h.value.as_str().trim().as_bytes(), want.as_bytes()))
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
    if m.len()>=10000 {
        m.retain(|_,bucket|now.saturating_sub(bucket.window_start)<window);
        if m.len()>=10000 && !m.contains_key(ip) {return false;}
    }
    let b = m.entry(ip.to_string()).or_insert(Bucket { window_start: now, count: 0 });
    if now.saturating_sub(b.window_start) >= window {
        b.window_start = now;
        b.count = 0;
    }
    b.count = b.count.saturating_add(1);
    b.count <= limit
}

fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn env_usize(key: &str, default: usize) -> usize {
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

fn resolve_client_ip(socket_ip: &str, headers: &[Header], trusted_hops: usize) -> String {
    if trusted_hops == 0 {
        return socket_ip.to_string();
    }
    let hops: Vec<&str> = headers
        .iter()
        .filter(|h| h.field.equiv("X-Forwarded-For"))
        .flat_map(|h| h.value.as_str().split(',').map(|s| s.trim()).filter(|s| !s.is_empty()))
        .collect();
    if hops.len() >= trusted_hops {
        let candidate = hops[hops.len() - trusted_hops];
        if candidate.parse::<std::net::IpAddr>().is_ok() {
            return candidate.to_string();
        }
    }
    socket_ip.to_string()
}

#[derive(Default)]
struct ClientBudget {
    write_window_start: u64,
    write_bytes: usize,
    new_rooms_window_start: u64,
    new_rooms_count: usize,
    created_rooms: std::collections::HashSet<String>,
}

/// Immutable relay configuration shared across worker threads.
struct Config {
    data_path: String,
    token: String,
    rate_limit: u32,
    rate_window: u64,
    active_polls: std::sync::atomic::AtomicUsize,
    max_polls: usize,
    trusted_hops: usize,
    ip_write_limit_bytes: usize,
    ip_new_rooms_limit: usize,
    ip_max_store_bytes: usize,
    quotas: Mutex<HashMap<String, ClientBudget>>,
}

impl Config {
    #[allow(clippy::too_many_arguments)]
    fn new(
        data_path: String,
        token: String,
        rate_limit: u32,
        rate_window: u64,
        max_polls: usize,
        trusted_hops: usize,
        ip_write_limit_bytes: usize,
        ip_new_rooms_limit: usize,
        ip_max_store_bytes: usize,
    ) -> Self {
        Self {
            data_path,
            token,
            rate_limit,
            rate_window,
            active_polls: std::sync::atomic::AtomicUsize::new(0),
            max_polls,
            trusted_hops,
            ip_write_limit_bytes,
            ip_new_rooms_limit,
            ip_max_store_bytes,
            quotas: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn test_default(data_path: String, token: String) -> Self {
        Self::new(
            data_path,
            token,
            100,
            60,
            1,
            0,
            16 * 1024 * 1024,
            1000,
            16 * 1024 * 1024,
        )
    }
}

/// Handle one request end-to-end (CORS, rate limit, auth, route). Runs on a
/// worker thread, so the blocking `poll` route only ties up that one thread.
// Reserve a bounded poll slot using APIs supported by older and current Rust.
fn reserve_poll(active: &std::sync::atomic::AtomicUsize, limit: usize) -> bool {
    use std::sync::atomic::Ordering;
    let mut count = active.load(Ordering::Acquire);
    while count < limit {
        match active.compare_exchange_weak(count, count + 1, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => return true,
            Err(actual) => count = actual,
        }
    }
    false
}

fn check_write_limits(ip: &str, path: &str, body: &str, store: &Store, cfg: &Config) -> Option<(u16, String)> {
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let room_key = if parts.len() == 5 && parts[0] == "v2" && parts[1] == "rooms" {
        format!("@v2:{}", parts[2])
    } else if parts.len() == 4 && parts[0] == "rooms" {
        parts[1].to_string()
    } else {
        return None;
    };

    let now = now_secs();
    let mut q_guard = cfg.quotas.lock().unwrap();
    if q_guard.len() >= 10000 {
        q_guard.retain(|_, b| {
            now.saturating_sub(b.write_window_start) < 3600
                || now.saturating_sub(b.new_rooms_window_start) < 3600
                || !b.created_rooms.is_empty()
        });
    }
    let budget = q_guard.entry(ip.to_string()).or_default();

    if now.saturating_sub(budget.write_window_start) >= 3600 {
        budget.write_window_start = now;
        budget.write_bytes = 0;
    }
    if budget.write_bytes.saturating_add(body.len()) > cfg.ip_write_limit_bytes {
        return Some((429, json!({"error": "client write byte budget exceeded"}).to_string()));
    }

    if now.saturating_sub(budget.new_rooms_window_start) >= 3600 {
        budget.new_rooms_window_start = now;
        budget.new_rooms_count = 0;
    }
    let store_guard = store.lock().unwrap();
    let is_new_room = !store_guard.contains_key(&room_key);
    if is_new_room && budget.new_rooms_count >= cfg.ip_new_rooms_limit {
        return Some((429, json!({"error": "new room limit exceeded for IP"}).to_string()));
    }

    let ip_stored: usize = budget.created_rooms.iter().filter_map(|r| store_guard.get(r).map(room_bytes)).sum();
    if ip_stored.saturating_add(body.len()) > cfg.ip_max_store_bytes {
        return Some((507, json!({"error": "client storage quota exceeded"}).to_string()));
    }

    None
}

fn record_successful_write(ip: &str, path: &str, body: &str, cfg: &Config) {
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let room_key = if parts.len() == 5 && parts[0] == "v2" && parts[1] == "rooms" {
        format!("@v2:{}", parts[2])
    } else if parts.len() == 4 && parts[0] == "rooms" {
        parts[1].to_string()
    } else {
        return;
    };
    let mut q_guard = cfg.quotas.lock().unwrap();
    let budget = q_guard.entry(ip.to_string()).or_default();
    budget.write_bytes = budget.write_bytes.saturating_add(body.len());
    if !budget.created_rooms.contains(&room_key) {
        budget.new_rooms_count += 1;
        budget.created_rooms.insert(room_key);
    }
}

fn serve(mut req: Request, store: &Store, versions: &Versions, rate: &RateMap, cfg: &Config) {
    REQUESTS.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
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

    // Rate limit by client IP. When RELAY_TRUSTED_HOPS is set, use the Nth
    // X-Forwarded-For hop from the right; otherwise use the socket IP.
    let socket_ip = req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "unknown".into());
    let ip = resolve_client_ip(&socket_ip, req.headers(), cfg.trusted_hops);
    if !rate_ok(rate, &ip, now_secs(), cfg.rate_limit, cfg.rate_window) {
        let _ = req.respond(cors_json(429, json!({"error": "rate limited"}).to_string()));
        return;
    }

    // Auth gate (health stays open for probes).
    let is_health = path.split('?').next().unwrap_or("").trim_end_matches('/')=="/health";
    if !is_health && !bearer_ok(req.headers(), &cfg.token) {
        let _ = req.respond(cors_json(401, json!({"error": "unauthorized"}).to_string()));
        return;
    }

    if method==Method::Get && path=="/metrics" {
        if cfg.token.is_empty() {
            let _ = req.respond(cors_json(403, json!({"error": "metrics disabled when RELAY_TOKEN is empty"}).to_string()));
            return;
        }
        let data=store.lock().unwrap();
        let payload=json!({"requests_total":REQUESTS.load(std::sync::atomic::Ordering::Relaxed),"durable_writes_total":DURABLE_WRITES.load(std::sync::atomic::Ordering::Relaxed),"storage_failures_total":STORAGE_FAILURES.load(std::sync::atomic::Ordering::Relaxed),"active_polls":cfg.active_polls.load(std::sync::atomic::Ordering::Relaxed),"rooms":data.len(),"records":data.values().map(|room|room.len()).sum::<usize>()}).to_string();
        drop(data);let _=req.respond(cors_json(200,payload));return;
    }
    let mut body = String::new();
    if req.body_length().is_some_and(|len|len>MAX_BODY) {let _=req.respond(cors_json(413,json!({"error":"request too large"}).to_string()));return;}
    let read = std::io::Read::read_to_string(&mut std::io::Read::take(req.as_reader(),MAX_BODY as u64+1),&mut body);
    if read.is_err() || body.len()>MAX_BODY {let _=req.respond(cors_json(413,json!({"error":"invalid or oversized request"}).to_string()));return;}

    // The long-poll route blocks; handle it here so route_v stays pure/non-blocking.
    // Both v1 (/rooms/{room}/poll) and v2 (/v2/rooms/{room}/poll) block using reserve_poll.
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let is_v1_poll = matches!((method.as_str(), parts.as_slice()), ("GET", ["rooms", _, "poll"]));
    let is_v2_poll = matches!((method.as_str(), parts.as_slice()), ("GET", ["v2", "rooms", _, "poll"]));
    let (status, payload) = if is_v1_poll || is_v2_poll {
        let room = if is_v1_poll { parts[1] } else { parts[2] };
        let version_key = if is_v2_poll { format!("@v2:{}", room) } else { room.to_string() };
        if !identifier(room) { (400,json!({"error":"invalid room"}).to_string()) }
        else if !reserve_poll(&cfg.active_polls, cfg.max_polls) {
            (503,json!({"error":"poll capacity exhausted; retry"}).to_string())
        } else {
            if is_v2_poll {
                let mut v_guard = versions.lock().unwrap();
                if !v_guard.contains_key(&version_key) {
                    let s_guard = store.lock().unwrap();
                    let cur = s_guard.get(&version_key).map(|r| r.values().filter_map(|v| v["cursor"].as_u64()).max().unwrap_or(0)).unwrap_or(0);
                    v_guard.insert(version_key.clone(), cur);
                }
            }
            let v = wait_for_change(versions, &version_key, parse_since(&path), POLL_TIMEOUT, POLL_INTERVAL);
            cfg.active_polls.fetch_sub(1,std::sync::atomic::Ordering::AcqRel);
            (200u16, json!({ "version": v }).to_string())
        }
    } else {
        if method == Method::Put {
            if let Some(err) = check_write_limits(&ip, &path, &body, store, cfg) {
                err
            } else {
                let res = durable_put(store, versions, &path, &body, &cfg.data_path);
                if res.0 == 200 {
                    record_successful_write(&ip, &path, &body, cfg);
                }
                res
            }
        } else {
            route_v(store, versions, method.as_str(), &path, &body)
        }
    };
    let _ = req.respond(cors_json(status, payload));
}

fn is_loopback_addr(addr: &str) -> bool {
    let host = if let Some(stripped) = addr.strip_prefix('[') {
        stripped.split(']').next().unwrap_or(stripped)
    } else {
        addr.split(':').next().unwrap_or(addr)
    };
    if host == "localhost" {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback();
    }
    if let Ok(sock) = addr.parse::<std::net::SocketAddr>() {
        return sock.ip().is_loopback();
    }
    false
}

fn resolve_max_polls(workers: u32, override_val: Option<&str>) -> usize {
    override_val
        .and_then(|v| v.parse().ok())
        .unwrap_or((workers / 2) as usize)
}

fn validate_startup_addr(addr: &str, token: &str, allow_open: bool) -> Result<(), String> {
    if token.is_empty() && !is_loopback_addr(addr) && !allow_open {
        return Err(format!(
            "RELAY_TOKEN is empty and RELAY_ADDR ({addr}) is not loopback. Refusing to start open relay on a non-loopback address without RELAY_ALLOW_OPEN=1."
        ));
    }
    Ok(())
}

fn main() {
    let addr = std::env::var("RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let data_path = std::env::var("RELAY_DATA").unwrap_or_else(|_| "relay-data.json".to_string());
    let token = std::env::var("RELAY_TOKEN").unwrap_or_default();
    let allow_open = std::env::var("RELAY_ALLOW_OPEN").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let room_quota_env = std::env::var("RELAY_ROOM_QUOTA")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_ROOM_QUOTA);
    ROOM_QUOTA.store(room_quota_env, std::sync::atomic::Ordering::Relaxed);

    if let Err(err) = validate_startup_addr(&addr, &token, allow_open) {
        eprintln!("ERROR: {err}");
        std::process::exit(1);
    }

    let rate_limit = env_u32("RELAY_RATE_LIMIT", 240); // requests…
    let rate_window = env_u32("RELAY_RATE_WINDOW", 60) as u64; // …per this many seconds, per IP
    let workers = env_u32("RELAY_WORKERS", 16).clamp(2,64); // a pool so long-polls don't block others
    let max_polls = resolve_max_polls(workers, std::env::var("RELAY_MAX_POLLS").ok().as_deref());

    let trusted_hops = std::env::var("RELAY_TRUSTED_HOPS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or_else(|| {
            let trust_proxy = std::env::var("RELAY_TRUST_PROXY").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
            if trust_proxy { 1 } else { 0 }
        });

    let server = Arc::new(Server::http(&addr).expect("failed to bind relay address"));
    let store: Arc<Store> = Arc::new(Mutex::new(load_store(&data_path).expect("Refusing to start with unreadable/corrupt relay data")));
    let versions: Arc<Versions> = Arc::new(Mutex::new(HashMap::new()));
    let rate: Arc<RateMap> = Arc::new(Mutex::new(HashMap::new()));
    let ip_write_limit_bytes = env_usize("RELAY_IP_WRITE_LIMIT_BYTES", 16 * 1024 * 1024);
    let ip_new_rooms_limit = env_usize("RELAY_IP_NEW_ROOMS_LIMIT", 10);
    let ip_max_store_bytes = env_usize("RELAY_IP_MAX_STORE_BYTES", 16 * 1024 * 1024);
    let cfg = Arc::new(Config::new(
        data_path,
        token,
        rate_limit,
        rate_window,
        max_polls,
        trusted_hops,
        ip_write_limit_bytes,
        ip_new_rooms_limit,
        ip_max_store_bytes,
    ));
    println!(
        "Cognate relay (E2E, ciphertext-only) on http://{addr} (data: {}, auth: {}, limit: {rate_limit}/{rate_window}s, workers: {workers}, max_polls: {max_polls})",
        cfg.data_path,
        if cfg.token.is_empty() { "open" } else { "token" }
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
        persist(&s1, p).unwrap();

        // Second "process": load from disk — the blob survives.
        let s2: Store = Mutex::new(load_store(p).unwrap());
        let (_, body) = route(&s2, "GET", "/rooms/r1/blobs", "");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["blobs"].as_array().unwrap().len(), 1);
        assert_eq!(v["blobs"][0]["ct"], "c");

        let _ = std::fs::remove_file(p);
    }
    #[test]
    fn failed_disk_commit_is_not_acknowledged_or_visible() {
        let s=empty();let versions=Mutex::new(HashMap::new());
        let path=std::env::temp_dir().join(format!("missing-relay-parent-{}",std::process::id())).join("data.json");
        assert_eq!(durable_put(&s,&versions,"/rooms/r/blobs/a",r#"{"v":1,"nonce":"n","ct":"c"}"#,path.to_str().unwrap()).0,503);
        assert!(s.lock().unwrap().is_empty());assert_eq!(current_version(&versions,"r"),0);
    }
    #[test]
    fn rejects_oversized_malformed_and_quota_requests() {
        let s=empty();
        assert_eq!(route(&s,"PUT","/rooms/r/blobs/a",&"x".repeat(MAX_BODY+1)).0,413);
        assert_eq!(route(&s,"PUT","/rooms/r/blobs/a","{}").0,400);
        assert_eq!(route(&s,"PUT","/rooms/../blobs/a",r#"{"v":1,"nonce":"n","ct":"c"}"#).0,400);
        for i in 0..MAX_ACTORS {assert_eq!(route(&s,"PUT",&format!("/rooms/r/blobs/a{i}"),r#"{"v":1,"nonce":"n","ct":"c"}"#).0,200);}
        assert_eq!(route(&s,"PUT","/rooms/r/blobs/extra",r#"{"v":1,"nonce":"n","ct":"c"}"#).0,507);
    }
    #[test]
    fn corrupt_store_never_silently_resets() {
        let path=std::env::temp_dir().join(format!("corrupt-relay-{}.json",std::process::id()));
        std::fs::write(&path,"broken").unwrap();
        assert!(load_store(path.to_str().unwrap()).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn immutable_batches_keep_cursors_across_restart_and_reject_replacement() {
        let path=std::env::temp_dir().join(format!("cognate-v2-{}.json",std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let store=empty();let versions=Mutex::new(HashMap::new());
        let body=r#"{"v":1,"nonce":"nonce","ct":"ciphertext"}"#;
        let first=durable_put(&store,&versions,"/v2/rooms/r/batches/b1",body,path.to_str().unwrap());
        assert_eq!(first.0,200);assert_eq!(serde_json::from_str::<Value>(&first.1).unwrap()["cursor"],1);
        assert_eq!(durable_put(&store,&versions,"/v2/rooms/r/batches/b1",body,path.to_str().unwrap()).1,first.1);
        assert_eq!(durable_put(&store,&versions,"/v2/rooms/r/batches/b1",r#"{"v":1,"nonce":"nonce","ct":"changed"}"#,path.to_str().unwrap()).0,409);
        // Legacy actor paths cannot address the reserved v2 storage namespace.
        assert_eq!(route(&store,"PUT","/rooms/@v2:r/blobs/b1",body).0,400);
        let restarted=Mutex::new(load_store(path.to_str().unwrap()).unwrap());
        assert_eq!(durable_put(&restarted,&versions,"/v2/rooms/r/batches/b2",body,path.to_str().unwrap()).0,200);
        let (_,page)=route(&restarted,"GET","/v2/rooms/r/batches?after=1","");let page:Value=serde_json::from_str(&page).unwrap();
        assert_eq!(page["cursor"],2);assert_eq!(page["batches"].as_array().unwrap().len(),1);assert_eq!(page["batches"][0]["batch_id"],"b2");
        assert_eq!(route(&restarted,"GET","/v2/rooms/r/batches?after=no","").0,400);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn real_http_put_reports_disk_failure_without_advancing_history() {
        use std::io::{Read,Write};
        let server=Server::http("127.0.0.1:0").unwrap();let addr=server.server_addr().to_ip().unwrap();
        let store=Arc::new(empty());let versions=Arc::new(Mutex::new(HashMap::new()));
        let copy=store.clone();let vc=versions.clone();
        let worker=thread::spawn(move || {
            let cfg=Config::test_default("/nonexistent-cognate-directory/relay.json".into(), "test-token".into());
            let request=server.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
            serve(request,&copy,&vc,&Mutex::new(HashMap::new()),&cfg);
        });
        let mut stream=std::net::TcpStream::connect(addr).unwrap();stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let body=r#"{"v":1,"nonce":"n","ct":"c"}"#;
        write!(stream,"PUT /v2/rooms/r/batches/b HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer test-token\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",body.len()).unwrap();
        let mut response=String::new();stream.read_to_string(&mut response).unwrap();worker.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 503"));assert!(response.contains("\"acknowledged\":false"));assert!(store.lock().unwrap().is_empty());
    }

    #[test]
    fn real_http_poll_saturation_keeps_health_worker_available() {
        fn get(addr:std::net::SocketAddr,path:&str)->String {
            use std::io::{Read,Write};
            let mut client=std::net::TcpStream::connect(addr).unwrap();client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            write!(client,"GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").unwrap();
            let mut result=String::new();client.read_to_string(&mut result).unwrap();result
        }
        let server=Arc::new(Server::http("127.0.0.1:0").unwrap());let addr=server.server_addr().to_ip().unwrap();
        let store=Arc::new(empty());let versions=Arc::new(Mutex::new(HashMap::new()));let rate=Arc::new(Mutex::new(HashMap::new()));
        let cfg=Arc::new(Config::test_default("unused".into(), String::new()));
        let stopped=Arc::new(std::sync::atomic::AtomicBool::new(false));let mut workers=Vec::new();
        for _ in 0..2 {
            let (server,store,versions,rate,cfg,stopped)=(server.clone(),store.clone(),versions.clone(),rate.clone(),cfg.clone(),stopped.clone());
            workers.push(thread::spawn(move || {while !stopped.load(std::sync::atomic::Ordering::SeqCst) {if let Some(req)=server.recv_timeout(Duration::from_millis(100)).unwrap() {serve(req,&store,&versions,&rate,&cfg);}}}));
        }
        let poll=thread::spawn(move || get(addr,"/rooms/r/poll?since=0"));
        let deadline=Instant::now()+Duration::from_secs(2);
        while cfg.active_polls.load(std::sync::atomic::Ordering::SeqCst)==0 && Instant::now()<deadline {thread::sleep(Duration::from_millis(10));}
        assert_eq!(cfg.active_polls.load(std::sync::atomic::Ordering::SeqCst),1);
        assert!(get(addr,"/rooms/r/poll?since=0").starts_with("HTTP/1.1 503"));
        assert!(get(addr,"/health").starts_with("HTTP/1.1 200"));
        versions.lock().unwrap().insert("r".into(),1);
        assert!(poll.join().unwrap().starts_with("HTTP/1.1 200"));
        stopped.store(true,std::sync::atomic::Ordering::SeqCst);for worker in workers {worker.join().unwrap();}
    }

    #[test]
    fn refuses_to_start_open_on_non_loopback_without_override() {
        assert!(validate_startup_addr("127.0.0.1:8787", "", false).is_ok());
        assert!(validate_startup_addr("localhost:8787", "", false).is_ok());
        assert!(validate_startup_addr("[::1]:8787", "", false).is_ok());
        assert!(validate_startup_addr("0.0.0.0:8787", "secret", false).is_ok());
        assert!(validate_startup_addr("0.0.0.0:8787", "", true).is_ok());
        assert!(validate_startup_addr("192.168.1.5:8787", "", false).is_err());
        let err = validate_startup_addr("0.0.0.0:8787", "", false).unwrap_err();
        assert!(err.contains("RELAY_TOKEN is empty"));
        assert!(err.contains("RELAY_ALLOW_OPEN=1"));
    }

    #[test]
    fn room_quota_blocks_excessive_room_storage_before_global_exhaustion() {
        let s = empty();
        set_room_quota_for_tests(80);
        let blob = r#"{"v":1,"nonce":"12345678","ct":"ciphertext-payload"}"#;
        // First blob in room 1 succeeds (52 bytes <= 80)
        let (code, _) = route(&s, "PUT", "/rooms/room1/blobs/actor1", blob);
        assert_eq!(code, 200);
        // Second blob in room 1 pushes room 1 over 80 bytes (104 > 80) -> 507 room quota exceeded
        let (code, body) = route(&s, "PUT", "/rooms/room1/blobs/actor2", blob);
        assert_eq!(code, 507);
        assert!(body.contains("room quota exceeded"));
        // Room 2 is independent and can still write successfully
        let (code, _) = route(&s, "PUT", "/rooms/room2/blobs/actor1", blob);
        assert_eq!(code, 200);

        // Also test v2 batch per-room quota
        let (code, _) = route(&s, "PUT", "/v2/rooms/v2room1/batches/b1", blob);
        assert_eq!(code, 200);
        let (code, body) = route(&s, "PUT", "/v2/rooms/v2room1/batches/b2", blob);
        assert_eq!(code, 507);
        assert!(body.contains("room quota exceeded"));
        let (code, _) = route(&s, "PUT", "/v2/rooms/v2room2/batches/b1", blob);
        assert_eq!(code, 200);

        // Reset room quota back to default
        reset_room_quota_for_tests();
    }

    #[test]
    fn real_http_v2_poll_blocks_and_respects_capacity() {
        fn get(addr: std::net::SocketAddr, path: &str) -> String {
            use std::io::{Read, Write};
            let mut client = std::net::TcpStream::connect(addr).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            write!(client, "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").unwrap();
            let mut result = String::new();
            client.read_to_string(&mut result).unwrap();
            result
        }
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let addr = server.server_addr().to_ip().unwrap();
        let store = Arc::new(empty());
        let versions = Arc::new(Mutex::new(HashMap::new()));
        let rate = Arc::new(Mutex::new(HashMap::new()));
        let cfg = Arc::new(Config::test_default("unused".into(), String::new()));
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut workers = Vec::new();
        for _ in 0..2 {
            let (server, store, versions, rate, cfg, stopped) = (
                server.clone(),
                store.clone(),
                versions.clone(),
                rate.clone(),
                cfg.clone(),
                stopped.clone(),
            );
            workers.push(thread::spawn(move || {
                while !stopped.load(std::sync::atomic::Ordering::SeqCst) {
                    if let Some(req) = server.recv_timeout(Duration::from_millis(100)).unwrap() {
                        serve(req, &store, &versions, &rate, &cfg);
                    }
                }
            }));
        }

        // 1. /version is non-blocking and returns current cursor (0)
        let ver = get(addr, "/v2/rooms/r/version");
        assert!(ver.starts_with("HTTP/1.1 200"));
        assert!(ver.contains("\"version\":0"));

        // 2. /v2/rooms/r/poll?since=0 occupies a poll slot and blocks
        let poll = thread::spawn(move || get(addr, "/v2/rooms/r/poll?since=0"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while cfg.active_polls.load(std::sync::atomic::Ordering::SeqCst) == 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(cfg.active_polls.load(std::sync::atomic::Ordering::SeqCst), 1);

        // 3. While poll slot is occupied, second poll gets 503 capacity exhausted
        assert!(get(addr, "/v2/rooms/r/poll?since=0").starts_with("HTTP/1.1 503"));

        // 4. Updating room cursor unblocks the waiting poll
        versions.lock().unwrap().insert("@v2:r".into(), 1);
        let poll_res = poll.join().unwrap();
        assert!(poll_res.starts_with("HTTP/1.1 200"));
        assert!(poll_res.contains("\"version\":1"));

        stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        for worker in workers {
            worker.join().unwrap();
        }
    }

    #[test]
    fn poll_capacity_respects_env_var_default_and_override() {
        assert_eq!(resolve_max_polls(16, None), 8);
        assert_eq!(resolve_max_polls(16, Some("4")), 4);
        assert_eq!(resolve_max_polls(16, Some("12")), 12);
        assert_eq!(resolve_max_polls(16, Some("invalid")), 8);
    }

    #[test]
    fn write_path_persists_safely_and_records_durable_writes() {
        let path = std::env::temp_dir().join(format!("cognate-write-path-{}.json", std::process::id()));
        let p = path.to_str().unwrap();
        let _ = std::fs::remove_file(p);

        let store = empty();
        let versions = Mutex::new(HashMap::new());
        let body = r#"{"v":1,"nonce":"nonce-1","ct":"ciphertext-1"}"#;
        let before_writes = DURABLE_WRITES.load(std::sync::atomic::Ordering::Relaxed);
        let (status, ack) = durable_put(&store, &versions, "/v2/rooms/bench/batches/b1", body, p);
        assert_eq!(status, 200);
        assert!(ack.contains("\"durable\":true"));
        assert!(DURABLE_WRITES.load(std::sync::atomic::Ordering::Relaxed) >= before_writes + 1);

        // Verify the file was written and can be reloaded
        let loaded = load_store(p).unwrap();
        assert!(loaded.contains_key("@v2:bench"));

        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn client_ip_with_trusted_hops_from_right_and_fallback() {
        let headers = vec![
            Header::from_bytes(&b"X-Forwarded-For"[..], &b"1.2.3.4, 203.0.113.195"[..]).unwrap(),
        ];
        // 1 hop trusted: leftmost spoofed value ignored, proxy-appended value used (1st from right)
        assert_eq!(resolve_client_ip("127.0.0.1", &headers, 1), "203.0.113.195");

        // 2 hops trusted: intermediate hop extracted
        let two_hops = vec![
            Header::from_bytes(&b"X-Forwarded-For"[..], &b"1.2.3.4, 203.0.113.195, 10.0.0.1"[..]).unwrap(),
        ];
        assert_eq!(resolve_client_ip("127.0.0.1", &two_hops, 2), "203.0.113.195");

        // Fewer hops than configured: falls back to socket IP
        assert_eq!(resolve_client_ip("127.0.0.1", &headers, 3), "127.0.0.1");

        // Malformed header: falls back to socket IP
        let malformed = vec![
            Header::from_bytes(&b"X-Forwarded-For"[..], &b"not-an-ip"[..]).unwrap(),
        ];
        assert_eq!(resolve_client_ip("127.0.0.1", &malformed, 1), "127.0.0.1");

        // 0 hops trusted: always socket IP
        assert_eq!(resolve_client_ip("127.0.0.1", &headers, 0), "127.0.0.1");

        // whitespace trimming
        let padded = vec![
            Header::from_bytes(&b"X-Forwarded-For"[..], &b"  198.51.100.2 , 10.0.0.1 "[..]).unwrap(),
        ];
        assert_eq!(resolve_client_ip("127.0.0.1", &padded, 2), "198.51.100.2");
    }

    #[test]
    fn real_http_rate_limit_respects_trust_proxy() {
        fn req(addr: std::net::SocketAddr, xff: Option<&str>) -> String {
            use std::io::{Read, Write};
            let mut client = std::net::TcpStream::connect(addr).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let header = xff.map(|h| format!("X-Forwarded-For: {h}\r\n")).unwrap_or_default();
            write!(client, "GET /health HTTP/1.1\r\nHost: {addr}\r\n{header}Connection: close\r\n\r\n").unwrap();
            let mut result = String::new();
            client.read_to_string(&mut result).unwrap();
            result
        }
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let addr = server.server_addr().to_ip().unwrap();
        let store = Arc::new(empty());
        let versions = Arc::new(Mutex::new(HashMap::new()));
        let rate = Arc::new(Mutex::new(HashMap::new()));
        // Rate limit: 2 requests per window. trusted_hops: 1.
        let mut cfg_val = Config::test_default("unused".into(), String::new());
        cfg_val.rate_limit = 2;
        cfg_val.trusted_hops = 1;
        let cfg = Arc::new(cfg_val);
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s, st, v, r, c, sp) = (server.clone(), store.clone(), versions.clone(), rate.clone(), cfg.clone(), stopped.clone());
        let worker = thread::spawn(move || {
            while !sp.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(req) = s.recv_timeout(Duration::from_millis(100)).unwrap() {
                    serve(req, &st, &v, &r, &c);
                }
            }
        });

        // 2 requests from 10.0.0.1 -> both succeed
        assert!(req(addr, Some("10.0.0.1")).starts_with("HTTP/1.1 200"));
        assert!(req(addr, Some("10.0.0.1")).starts_with("HTTP/1.1 200"));
        // 3rd request from 10.0.0.1 -> rate limited (429)
        assert!(req(addr, Some("10.0.0.1")).starts_with("HTTP/1.1 429"));

        // Request from 10.0.0.2 over the same socket connection addr -> succeeds because trust_proxy separates by XFF
        assert!(req(addr, Some("10.0.0.2")).starts_with("HTTP/1.1 200"));

        stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        worker.join().unwrap();
    }

    #[test]
    fn bearer_token_comparison_constant_time() {
        // Confirms two tokens of the same length compare equal / unequal
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(b"token123", b"token123"));
        assert!(!constant_time_eq(b"token123", b"token124"));
        assert!(!constant_time_eq(b"token123", b"xoken123"));

        // Confirms two tokens of DIFFERENT lengths compare unequal without panicking
        assert!(!constant_time_eq(b"token123", b"token12"));
        assert!(!constant_time_eq(b"token12", b"token123"));
        assert!(!constant_time_eq(b"", b"token123"));
        assert!(!constant_time_eq(b"token123", b""));
        assert!(!constant_time_eq(b"short", b"a very long token that exceeds the length of short significantly"));
        assert!(!constant_time_eq(b"a very long token that exceeds the length of short significantly", b"short"));

        let h = vec![Header::from_bytes(&b"Authorization"[..], &b"Bearer my-secret-token"[..]).unwrap()];
        assert!(bearer_ok(&h, "my-secret-token"));
        assert!(!bearer_ok(&h, "my-secret-tokeo"));
        assert!(!bearer_ok(&h, "ny-secret-token"));
        assert!(!bearer_ok(&h, "short"));
        assert!(!bearer_ok(&h, "my-secret-token-extended"));
    }

    #[test]
    fn metrics_endpoint_disabled_when_token_empty_and_requires_bearer_when_configured() {
        fn get(addr: std::net::SocketAddr, token: Option<&str>) -> (u16, String) {
            use std::io::{Read, Write};
            let mut client = std::net::TcpStream::connect(addr).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
            write!(client, "GET /metrics HTTP/1.1\r\nHost: {addr}\r\n{auth}Connection: close\r\n\r\n").unwrap();
            let mut result = String::new();
            client.read_to_string(&mut result).unwrap();
            let status = result.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
            (status, result)
        }

        // Case 1: Open relay (RELAY_TOKEN is empty) -> /metrics must be disabled (403)
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let addr = server.server_addr().to_ip().unwrap();
        let store = Arc::new(empty());
        let versions = Arc::new(Mutex::new(HashMap::new()));
        let rate = Arc::new(Mutex::new(HashMap::new()));
        let cfg = Arc::new(Config::test_default("unused".into(), String::new()));
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s, st, v, r, c, sp) = (server.clone(), store.clone(), versions.clone(), rate.clone(), cfg.clone(), stopped.clone());
        let worker = thread::spawn(move || {
            while !sp.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(req) = s.recv_timeout(Duration::from_millis(100)).unwrap() {
                    serve(req, &st, &v, &r, &c);
                }
            }
        });

        let (status, body) = get(addr, None);
        assert_eq!(status, 403, "expected 403 when token is empty, got {status}: {body}");

        stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        worker.join().unwrap();

        // Case 2: Configured token -> requires matching bearer token
        let server2 = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let addr2 = server2.server_addr().to_ip().unwrap();
        let cfg2 = Arc::new(Config::test_default("unused".into(), "secret-token".into()));
        let stopped2 = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s2, st2, v2, r2, c2, sp2) = (server2.clone(), store.clone(), versions.clone(), rate.clone(), cfg2.clone(), stopped2.clone());
        let worker2 = thread::spawn(move || {
            while !sp2.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(req) = s2.recv_timeout(Duration::from_millis(100)).unwrap() {
                    serve(req, &st2, &v2, &r2, &c2);
                }
            }
        });

        let (status, _) = get(addr2, None);
        assert_eq!(status, 401, "expected 401 without token");
        let (status, _) = get(addr2, Some("wrong-token"));
        assert_eq!(status, 401, "expected 401 with wrong token");
        let (status, body) = get(addr2, Some("secret-token"));
        assert_eq!(status, 200, "expected 200 with matching token, got {status}: {body}");
        assert!(body.contains("\"requests_total\""));

        stopped2.store(true, std::sync::atomic::Ordering::SeqCst);
        worker2.join().unwrap();
    }

    #[test]
    fn client_spreading_writes_hits_quota_and_other_client_can_write() {
        let server = Arc::new(Server::http("127.0.0.1:0").unwrap());
        let addr = server.server_addr().to_ip().unwrap();
        let store = Arc::new(empty());
        let versions = Arc::new(Mutex::new(HashMap::new()));
        let rate = Arc::new(Mutex::new(HashMap::new()));
        let temp_dir = std::env::temp_dir().join(format!("cognate-quota-{}.json", std::process::id()));
        let p = temp_dir.to_str().unwrap().to_string();

        let mut cfg_val = Config::test_default(p.clone(), String::new());
        cfg_val.ip_new_rooms_limit = 3; // Cap at 3 new rooms for an IP
        cfg_val.trusted_hops = 1;
        let cfg = Arc::new(cfg_val);

        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s, st, v, r, c, sp) = (server.clone(), store.clone(), versions.clone(), rate.clone(), cfg.clone(), stopped.clone());
        let worker = thread::spawn(move || {
            while !sp.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(req) = s.recv_timeout(Duration::from_millis(100)).unwrap() {
                    serve(req, &st, &v, &r, &c);
                }
            }
        });

        fn put_batch(addr: std::net::SocketAddr, room: &str, batch_id: &str, xff: &str) -> u16 {
            use std::io::{Read, Write};
            let mut client = std::net::TcpStream::connect(addr).unwrap();
            client.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let body = r#"{"v":1,"nonce":"YWJjZGVmZ2hpamts","ct":"dGVzdA=="}"#;
            let req = format!("PUT /v2/rooms/{room}/batches/{batch_id} HTTP/1.1\r\nHost: {addr}\r\nX-Forwarded-For: {xff}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            client.write_all(req.as_bytes()).unwrap();
            let mut result = String::new();
            client.read_to_string(&mut result).unwrap();
            result.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0)
        }

        // Client 1 (10.0.0.1) creates 3 rooms -> all succeed
        assert_eq!(put_batch(addr, "room1", "b1", "10.0.0.1"), 200);
        assert_eq!(put_batch(addr, "room2", "b1", "10.0.0.1"), 200);
        assert_eq!(put_batch(addr, "room3", "b1", "10.0.0.1"), 200);

        // Client 1 tries to create 4th room -> blocked by quota (429)
        assert_eq!(put_batch(addr, "room4", "b1", "10.0.0.1"), 429);

        // Global store is NOT exhausted; Client 2 (10.0.0.2) can still write to room4
        assert_eq!(put_batch(addr, "room4", "b1", "10.0.0.2"), 200);

        stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        worker.join().unwrap();
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn two_interleaved_puts_with_slow_fsync_persist_monotonically() {
        let path = std::env::temp_dir().join(format!("cognate-monotonic-{}.json", std::process::id()));
        let p = path.to_str().unwrap().to_string();
        let _ = std::fs::remove_file(&p);

        let store = Arc::new(empty());
        let versions = Arc::new(Mutex::new(HashMap::new()));

        let p1 = p.clone();
        let s1 = store.clone();
        let v1 = versions.clone();
        let t1 = thread::spawn(move || {
            TEST_FSYNC_DELAY.with(|c| c.set(50));
            let body = r#"{"v":1,"nonce":"nonce-1","ct":"ct-1"}"#;
            durable_put(&s1, &v1, "/v2/rooms/mono/batches/b1", body, &p1)
        });

        // Let t1 start and enter durable_put
        thread::sleep(Duration::from_millis(10));

        let p2 = p.clone();
        let s2 = store.clone();
        let v2 = versions.clone();
        let t2 = thread::spawn(move || {
            let body = r#"{"v":1,"nonce":"nonce-2","ct":"ct-2"}"#;
            durable_put(&s2, &v2, "/v2/rooms/mono/batches/b2", body, &p2)
        });

        let (status1, _) = t1.join().unwrap();
        let (status2, _) = t2.join().unwrap();
        assert_eq!(status1, 200);
        assert_eq!(status2, 200);

        // Reload the store file from disk: must contain BOTH b1 and b2
        let loaded = load_store(&p).unwrap();
        let room = loaded.get("@v2:mono").expect("room @v2:mono must exist on disk");
        assert!(room.contains_key("b1"), "b1 must be persisted");
        assert!(room.contains_key("b2"), "b2 must be persisted");

        let _ = std::fs::remove_file(&p);
    }
}
