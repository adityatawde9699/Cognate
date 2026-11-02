use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
#[cfg(test)]
use std::time::Duration;
use serde_json::{json, Value};
use crate::quota::MAX_STORE;
use crate::routes::route_v;

pub type Store = Mutex<HashMap<String, HashMap<String, Value>>>;
pub type Versions = Mutex<HashMap<String, u64>>;
pub type Data = HashMap<String, HashMap<String, Value>>;

pub static REQUESTS: AtomicU64 = AtomicU64::new(0);
pub static DURABLE_WRITES: AtomicU64 = AtomicU64::new(0);
pub static STORAGE_FAILURES: AtomicU64 = AtomicU64::new(0);

pub static WRITE_LOCK: Mutex<()> = Mutex::new(());
pub static PERSIST_GENERATION: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    pub static TEST_FSYNC_DELAY: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    pub static TEST_TIME_OFFSET: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    pub static TEST_MIN_CLAIM_AGE: std::cell::Cell<Option<u64>> = const { std::cell::Cell::new(None) };
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn effective_now_secs() -> u64 {
    let env_offset = std::env::var("RELAY_TIME_OFFSET")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    #[cfg(test)]
    {
        now_secs() + env_offset + TEST_TIME_OFFSET.with(|c| c.get())
    }
    #[cfg(not(test))]
    {
        now_secs() + env_offset
    }
}

#[cfg(test)]
pub fn set_test_time_offset(offset: u64) {
    TEST_TIME_OFFSET.with(|c| c.set(offset));
}

#[cfg(test)]
pub fn set_test_min_claim_age(age: Option<u64>) {
    TEST_MIN_CLAIM_AGE.with(|c| c.set(age));
}

pub fn min_claim_age_secs() -> u64 {
    #[cfg(test)]
    {
        if let Some(age) = TEST_MIN_CLAIM_AGE.with(|c| c.get()) {
            return age;
        }
    }
    #[cfg(test)]
    let default_val = 0;
    #[cfg(not(test))]
    let default_val = 86400;

    std::env::var("RELAY_MIN_CLAIM_AGE_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default_val)
}

pub fn purge_expired_rooms(data: &mut Data, versions: &mut HashMap<String, u64>, now: u64) {
    let mut to_remove = Vec::new();
    for (room_key, room_data) in data.iter() {
        if let Some(meta) = room_data.get("@meta") {
            if let Some(del_at) = meta.get("soft_deleted_at").and_then(|v| v.as_u64()) {
                if now >= del_at + 604800 {
                    to_remove.push(room_key.clone());
                }
            }
        }
    }
    for r in to_remove {
        data.remove(&r);
        versions.remove(&r);
    }
}

/// Missing data starts empty; corruption/permission errors fail startup.
pub fn load_store(path: &str) -> Result<Data, String> {
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.len() > MAX_STORE as u64 => return Err("Relay store exceeds quota".into()),
        _ => {},
    }
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

pub fn persist_bytes(json: &[u8], path: &str) -> Result<(), String> {
    #[cfg(test)]
    {
        let delay = TEST_FSYNC_DELAY.with(|c| c.get());
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
    }
    use std::io::Write;
    let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let tmp = format!("{path}.{}.{}.pending", std::process::id(), unique);
    let result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
        let mut file = options.open(&tmp)?;
        file.write_all(json)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        #[cfg(unix)] {
            let parent = std::path::Path::new(path).parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."));
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&tmp); }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
pub fn persist_data(data: &Data, path: &str) -> Result<(), String> {
    let json = serde_json::to_vec(data).map_err(|e| e.to_string())?;
    if json.len() > MAX_STORE { return Err("Relay store quota exceeded".into()); }
    persist_bytes(&json, path)
}

#[cfg(test)]
pub fn persist(store: &Store, path: &str) -> Result<(), String> {
    persist_data(&*store.lock().map_err(|e| e.to_string())?, path)
}

pub fn identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Acknowledge only after the proposed snapshot has been synced and published.
/// Mutex is released during fsync to reduce contention.
pub fn durable_write(store: &Store, versions: &Versions, method: &str, path: &str, body: &str, data_path: &str) -> (u16, String) {
    let _write_permit = WRITE_LOCK.lock().unwrap();

    let candidate_versions = Mutex::new(HashMap::new());
    let (candidate, response, json_bytes, next_gen) = {
        let guard = store.lock().unwrap();
        let candidate = Mutex::new(guard.clone());
        let response = route_v(&candidate, &candidate_versions, method, path, body);
        if response.0 != 200 {
            return response;
        }
        let candidate = candidate.into_inner().unwrap();
        let json = match serde_json::to_vec(&candidate) {
            Ok(j) if j.len() <= MAX_STORE => j,
            Ok(_) => return (507, json!({"error": "store quota exceeded"}).to_string()),
            Err(e) => {
                STORAGE_FAILURES.fetch_add(1, Ordering::Relaxed);
                return (503, json!({"error": format!("serialization failed: {e}"), "acknowledged": false}).to_string());
            }
        };
        let current_gen = PERSIST_GENERATION.load(Ordering::SeqCst);
        (candidate, response, json, current_gen + 1)
    }; // store mutex dropped here before fsync

    if let Err(error) = persist_bytes(&json_bytes, data_path) {
        STORAGE_FAILURES.fetch_add(1, Ordering::Relaxed);
        eprintln!("Relay persistence failed: {error}");
        return (503, json!({"error": "durable storage unavailable; retry", "acknowledged": false}).to_string());
    }

    *store.lock().unwrap() = candidate;
    PERSIST_GENERATION.store(next_gen, Ordering::SeqCst);
    DURABLE_WRITES.fetch_add(1, Ordering::Relaxed);
    for (room, v) in candidate_versions.into_inner().unwrap() {
        if room.starts_with("@v2:") {
            versions.lock().unwrap().insert(room, v);
        } else {
            *versions.lock().unwrap().entry(room).or_insert(0) += v;
        }
    }
    response
}

#[cfg(test)]
pub fn durable_put(store: &Store, versions: &Versions, path: &str, body: &str, data_path: &str) -> (u16, String) {
    durable_write(store, versions, "PUT", path, body, data_path)
}
