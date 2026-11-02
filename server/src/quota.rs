use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use serde_json::{json, Value};
use crate::ratelimit::ip_budget_key;
use crate::store::{now_secs, Store};

pub const MAX_BODY: usize = 1_048_576;
pub const MAX_STORE: usize = 32 * 1_048_576;
pub const MAX_ROOMS: usize = 1000;
pub const MAX_ACTORS: usize = 128;
/// Default per-room byte quota (8 MB). Configurable via RELAY_ROOM_QUOTA.
pub const DEFAULT_ROOM_QUOTA: usize = 8 * 1_048_576;
pub static ROOM_QUOTA: AtomicUsize = AtomicUsize::new(DEFAULT_ROOM_QUOTA);

thread_local! {
    static TEST_ROOM_QUOTA: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) };
}

pub fn room_quota() -> usize {
    TEST_ROOM_QUOTA.with(|c| c.get()).unwrap_or_else(|| {
        ROOM_QUOTA.load(Ordering::Relaxed)
    })
}

#[cfg(test)]
pub fn set_room_quota_for_tests(quota: usize) {
    TEST_ROOM_QUOTA.with(|c| c.set(Some(quota)));
}

#[cfg(test)]
pub fn reset_room_quota_for_tests() {
    TEST_ROOM_QUOTA.with(|c| c.set(None));
}

pub fn room_bytes(room_data: &HashMap<String, Value>) -> usize {
    room_data.values().map(|v| serde_json::to_vec(v).map_or(0, |b| b.len())).sum()
}

#[derive(Default)]
pub struct ClientBudget {
    pub write_window_start: u64,
    pub write_bytes: usize,
    pub new_rooms_window_start: u64,
    pub new_rooms_count: usize,
    pub created_rooms: HashSet<String>,
    pub failed_tokens_window_start: u64,
    pub failed_tokens_count: u32,
}

pub fn check_write_limits(ip: &str, path: &str, body: &str, store: &Store, cfg: &crate::Config) -> Option<(u16, String)> {
    let key = ip_budget_key(ip);
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let room_key = if (parts.len() == 4 || parts.len() == 5) && parts[0] == "v2" && parts[1] == "rooms" {
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
        if q_guard.len() >= 10000 && !q_guard.contains_key(&key) {
            let oldest_key = q_guard
                .iter()
                .filter(|(_, b)| b.created_rooms.is_empty())
                .min_by_key(|(_, b)| b.write_window_start.max(b.new_rooms_window_start))
                .map(|(k, _)| k.clone())
                .or_else(|| {
                    q_guard
                        .iter()
                        .min_by_key(|(_, b)| b.write_window_start.max(b.new_rooms_window_start))
                        .map(|(k, _)| k.clone())
                });
            if let Some(k) = oldest_key {
                q_guard.remove(&k);
            }
        }
    }
    let budget = q_guard.entry(key).or_default();

    let is_token_op = (parts.len() == 4 || parts.len() == 5) && parts[0] == "v2" && parts[1] == "rooms" && ["delete", "undelete", "claim", "freeze"].contains(&parts[3]);
    if is_token_op {
        if now.saturating_sub(budget.failed_tokens_window_start) >= 60 {
            budget.failed_tokens_window_start = now;
            budget.failed_tokens_count = 0;
        }
        if budget.failed_tokens_count >= 10 {
            return Some((429, json!({"error": "too many failed token attempts; try again later"}).to_string()));
        }
    }

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

pub fn record_successful_write(ip: &str, path: &str, body: &str, cfg: &crate::Config) {
    let key = ip_budget_key(ip);
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();
    let room_key = if (parts.len() == 4 || parts.len() == 5) && parts[0] == "v2" && parts[1] == "rooms" {
        format!("@v2:{}", parts[2])
    } else if parts.len() == 4 && parts[0] == "rooms" {
        parts[1].to_string()
    } else {
        return;
    };
    let now = now_secs();
    let mut q_guard = cfg.quotas.lock().unwrap();
    let budget = q_guard.entry(key).or_default();
    if budget.write_window_start == 0 || now.saturating_sub(budget.write_window_start) >= 3600 {
        budget.write_window_start = now;
        budget.write_bytes = 0;
    }
    budget.write_bytes = budget.write_bytes.saturating_add(body.len());
    if budget.new_rooms_window_start == 0 || now.saturating_sub(budget.new_rooms_window_start) >= 3600 {
        budget.new_rooms_window_start = now;
        budget.new_rooms_count = 0;
    }
    if !budget.created_rooms.contains(&room_key) {
        budget.new_rooms_count += 1;
        budget.created_rooms.insert(room_key);
    }
}
