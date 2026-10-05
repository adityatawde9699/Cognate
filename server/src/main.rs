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

fn persist_data(data: &Data, path: &str) -> Result<(),String> {
    use std::io::Write;
    let json = serde_json::to_vec(data).map_err(|e|e.to_string())?;
    if json.len()>MAX_STORE {return Err("Relay store quota exceeded".into());}
    let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e|e.to_string())?.as_nanos();
    let tmp = format!("{path}.{}.{}.pending",std::process::id(),unique);
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp)?;
        file.write_all(&json)?;
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
fn persist(store: &Store, path: &str) -> Result<(),String> {
    persist_data(&*store.lock().map_err(|e|e.to_string())?,path)
}
fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len()<=128 && value.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-' || b==b'_')
}

/// Acknowledge only after the proposed snapshot has been synced and published.
fn durable_put(store: &Store, versions: &Versions, path: &str, body: &str, data_path: &str) -> (u16,String) {
    let mut guard = store.lock().unwrap();
    let candidate = Mutex::new(guard.clone());
    let candidate_versions = Mutex::new(HashMap::new());
    let response = route_v(&candidate,&candidate_versions,"PUT",path,body);
    if response.0!=200 {return response;}
    let candidate = candidate.into_inner().unwrap();
    if let Err(error) = persist_data(&candidate,data_path) {
        STORAGE_FAILURES.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
        eprintln!("Relay persistence failed: {error}");
        return (503,json!({"error":"durable storage unavailable; retry","acknowledged":false}).to_string());
    }
    *guard = candidate;
    DURABLE_WRITES.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
    for (room,_) in candidate_versions.into_inner().unwrap() {
        *versions.lock().unwrap().entry(room).or_insert(0)+=1;
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
        return batch_route(store,method,path,body);
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
            let mut candidate = s.clone();
            candidate.entry((*room).into()).or_default().insert((*actor).into(),blob.clone());
            if serde_json::to_vec(&candidate).map_or(true,|data|data.len()>MAX_STORE) {return (507,json!({"error":"store quota exceeded"}).to_string());}
            if old.as_ref()==Some(&blob) {return (200,json!({"ok":true}).to_string());}
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
        ("GET", ["health"]) => (200, json!({"ok": true,"protocol":2}).to_string()),
        _ => (404, json!({"error": "not found"}).to_string()),
    }
}

fn batch_route(store: &Store, method: &str, path: &str, body: &str) -> (u16,String) {
    let parts: Vec<_> = path.split('?').next().unwrap_or("").split('/').filter(|s|!s.is_empty()).collect();
    if parts.len()<4 || parts[1]!="rooms" || !["batches","version","poll"].contains(&parts[3]) || !identifier(parts[2]) {
        return (400,json!({"error":"invalid batch path"}).to_string());
    }
    let room = format!("@v2:{}",parts[2]);
    let mut guard = store.lock().unwrap();
    if method=="GET" && parts.len()==4 && ["version","poll"].contains(&parts[3]) {
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
            let cursor=guard.get(&room).map(|r|r.values().filter_map(|v|v["cursor"].as_u64()).max().unwrap_or(0)).unwrap_or(0)+1;
            blob["batch_id"]=json!(parts[4]); blob["cursor"]=json!(cursor);
            let mut candidate=guard.clone(); candidate.entry(room).or_default().insert(parts[4].into(),blob);
            if serde_json::to_vec(&candidate).map_or(true,|d|d.len()>MAX_STORE) {return (507,json!({"error":"store quota exceeded"}).to_string());}
            *guard=candidate;
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
    active_polls: std::sync::atomic::AtomicUsize,
    max_polls: usize,
}

/// Handle one request end-to-end (CORS, rate limit, auth, route). Runs on a
/// worker thread, so the blocking `poll` route only ties up that one thread.
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

    // Rate limit by client IP (fixed window).
    let ip = req.remote_addr().map(|a| a.ip().to_string()).unwrap_or_else(|| "unknown".into());
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
        let data=store.lock().unwrap();
        let payload=json!({"requests_total":REQUESTS.load(std::sync::atomic::Ordering::Relaxed),"durable_writes_total":DURABLE_WRITES.load(std::sync::atomic::Ordering::Relaxed),"storage_failures_total":STORAGE_FAILURES.load(std::sync::atomic::Ordering::Relaxed),"active_polls":cfg.active_polls.load(std::sync::atomic::Ordering::Relaxed),"rooms":data.len(),"records":data.values().map(|room|room.len()).sum::<usize>()}).to_string();
        drop(data);let _=req.respond(cors_json(200,payload));return;
    }
    let mut body = String::new();
    if req.body_length().is_some_and(|len|len>MAX_BODY) {let _=req.respond(cors_json(413,json!({"error":"request too large"}).to_string()));return;}
    let read = std::io::Read::read_to_string(&mut std::io::Read::take(req.as_reader(),MAX_BODY as u64+1),&mut body);
    if read.is_err() || body.len()>MAX_BODY {let _=req.respond(cors_json(413,json!({"error":"invalid or oversized request"}).to_string()));return;}

    // The long-poll route blocks; handle it here so route_v stays pure/non-blocking.
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let (status, payload) = if let ("GET", ["rooms", room, "poll"]) = (method.as_str(), parts.as_slice()) {
        if !identifier(room) { (400,json!({"error":"invalid room"}).to_string()) }
        else if cfg.active_polls.fetch_update(std::sync::atomic::Ordering::AcqRel,std::sync::atomic::Ordering::Acquire,|n|(n<cfg.max_polls).then_some(n+1)).is_err() {
            (503,json!({"error":"poll capacity exhausted; retry"}).to_string())
        } else {
            let v = wait_for_change(versions, room, parse_since(&path), POLL_TIMEOUT, POLL_INTERVAL);
            cfg.active_polls.fetch_sub(1,std::sync::atomic::Ordering::AcqRel);
            (200u16, json!({ "version": v }).to_string())
        }
    } else {
        if method==Method::Put {durable_put(store,versions,&path,&body,&cfg.data_path)}
        else {route_v(store, versions, method.as_str(), &path, &body)}
    };
    let _ = req.respond(cors_json(status, payload));
}

fn main() {
    let addr = std::env::var("RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let data_path = std::env::var("RELAY_DATA").unwrap_or_else(|_| "relay-data.json".to_string());
    let token = std::env::var("RELAY_TOKEN").unwrap_or_default();
    let rate_limit = env_u32("RELAY_RATE_LIMIT", 240); // requests…
    let rate_window = env_u32("RELAY_RATE_WINDOW", 60) as u64; // …per this many seconds, per IP
    let workers = env_u32("RELAY_WORKERS", 16).clamp(2,64); // a pool so long-polls don't block others

    let server = Arc::new(Server::http(&addr).expect("failed to bind relay address"));
    let store: Arc<Store> = Arc::new(Mutex::new(load_store(&data_path).expect("Refusing to start with unreadable/corrupt relay data")));
    let versions: Arc<Versions> = Arc::new(Mutex::new(HashMap::new()));
    let rate: Arc<RateMap> = Arc::new(Mutex::new(HashMap::new()));
    let open = token.is_empty();
    let cfg = Arc::new(Config { data_path, token, rate_limit, rate_window,active_polls:std::sync::atomic::AtomicUsize::new(0),max_polls:(workers/2) as usize });
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
            let cfg=Config {data_path:"/nonexistent-cognate-directory/relay.json".into(),token:"test-token".into(),rate_limit:100,rate_window:60,active_polls:std::sync::atomic::AtomicUsize::new(0),max_polls:1};
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
        let cfg=Arc::new(Config {data_path:"unused".into(),token:String::new(),rate_limit:100,rate_window:60,active_polls:std::sync::atomic::AtomicUsize::new(0),max_polls:1});
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

}
