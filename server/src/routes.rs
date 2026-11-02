use std::collections::HashMap;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use serde_json::{json, Value};
use tiny_http::{Header, Response};

use crate::auth::{authorize_token, constant_time_eq};
use crate::quota::{room_bytes, room_quota, MAX_ACTORS, MAX_BODY, MAX_ROOMS, MAX_STORE};
use crate::store::{effective_now_secs, identifier, min_claim_age_secs, purge_expired_rooms, Store, Versions};

pub fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

pub fn cors_json(status: u16, body: String) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Access-Control-Allow-Origin", "*"))
}

pub fn capabilities_json() -> String {
    json!({
        "ok": true,
        "protocol": 2,
        "relay_version": "0.2.0",
        "delete_supported": true,
        "claim_supported": true,
        "freeze_supported": true,
        "max_body": MAX_BODY,
        "room_quota": room_quota(),
        "max_store": MAX_STORE,
    }).to_string()
}

pub fn route(store: &Store, method: &str, path: &str, body: &str) -> (u16, String) {
    let versions: Versions = Mutex::new(HashMap::new());
    route_v(store, &versions, method, path, body)
}

pub fn route_v(store: &Store, versions: &Versions, method: &str, path: &str, body: &str) -> (u16, String) {
    let parts: Vec<&str> = path.split('?').next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();

    // V2 is an immutable, durable batch journal. Cursors live with ciphertext,
    // so restart never rewinds a client's incremental position.
    if parts.first()==Some(&"v2") {
        if parts == ["v2", "capabilities"] && method == "GET" {
            return (200, capabilities_json());
        }
        return batch_route(store,versions,method,path,body);
    }
    if parts.first()==Some(&"rooms") && (parts.len()<2 || !identifier(parts[1]) || (parts.len()==4 && !identifier(parts[3]))) {return (400,json!({"error":"invalid room or actor"}).to_string());}
    match (method, parts.as_slice()) {
        ("GET", ["capabilities"]) => (200, capabilities_json()),
        ("GET", ["health"]) => (200, capabilities_json()),
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
        _ => (404, json!({"error": "not found"}).to_string()),
    }
}

pub fn batch_route(store: &Store, versions: &Versions, method: &str, path: &str, body: &str) -> (u16,String) {
    let parts: Vec<_> = path.split('?').next().unwrap_or("").split('/').filter(|s|!s.is_empty()).collect();
    if parts.len() == 2 && parts[1] == "capabilities" && method == "GET" {
        return (200, capabilities_json());
    }
    if parts.len()<4 || parts[1]!="rooms" || !["batches","version","delete","undelete","claim","freeze"].contains(&parts[3]) || !identifier(parts[2]) {
        return (400,json!({"error":"invalid batch path"}).to_string());
    }
    let room = format!("@v2:{}",parts[2]);

    // Wire rule: delete, undelete, and freeze are POST only, token in the JSON body, never in a URL or query string.
    if ["delete", "undelete", "freeze"].contains(&parts[3]) {
        if method != "POST" {
            return (405, json!({"error": "method not allowed; use POST"}).to_string());
        }
        if path.contains('?') {
            return (400, json!({"error": "tokens must be provided in JSON body, not query parameters"}).to_string());
        }
    }
    if parts[3] == "claim" {
        if method != "POST" && method != "GET" {
            return (405, json!({"error": "method not allowed; use POST or GET"}).to_string());
        }
        if path.contains('?') {
            return (400, json!({"error": "tokens must be provided in JSON body, not query parameters"}).to_string());
        }
    }

    let mut guard = store.lock().unwrap();

    purge_expired_rooms(&mut guard, &mut versions.lock().unwrap(), effective_now_secs());

    let is_soft_deleted = guard
        .get(&room)
        .and_then(|r| r.get("@meta"))
        .and_then(|m| m.get("soft_deleted_at"))
        .is_some();

    if is_soft_deleted && parts[3] != "undelete" {
        return (410, json!({"error": "room is soft-deleted; pending purge"}).to_string());
    }

    if method=="GET" && parts.len()==4 && parts[3]=="version" {
        let version=guard.get(&room).map(|r|r.values().filter_map(|v|v["cursor"].as_u64()).max().unwrap_or(0)).unwrap_or(0);
        return (200,json!({"version":version}).to_string());
    }

    if parts.len() == 4 && parts[3] == "claim" {
        if method == "GET" {
            let room_data = match guard.get(&room) {
                Some(r) => r,
                None => return (404, json!({"error": "room not found"}).to_string()),
            };
            let meta = room_data.get("@meta");
            let hash = meta.and_then(|m| m.get("delete_token_hash")).and_then(|h| h.as_str());
            let claimed_at = meta.and_then(|m| m.get("claimed_at")).and_then(|c| c.as_u64());
            return match hash {
                Some(h) => (200, json!({"claimed": true, "delete_token_hash": h, "claimed_at": claimed_at, "room": parts[2]}).to_string()),
                None => (200, json!({"claimed": false, "room": parts[2]}).to_string()),
            };
        }
        let hash = match serde_json::from_str::<Value>(body) {
            Ok(v) => v.get("delete_token_hash").and_then(|t| t.as_str()).map(|s| s.to_string()),
            Err(_) => None,
        };
        let hash = match hash {
            Some(h) if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()) => h.to_ascii_lowercase(),
            _ => return (400, json!({"error": "invalid delete_token_hash format; expected 64-character hex"}).to_string()),
        };
        let room_data = match guard.get_mut(&room) {
            Some(r) => r,
            None => return (404, json!({"error": "room not found"}).to_string()),
        };
        let meta = room_data.entry("@meta".to_string()).or_insert_with(|| json!({"@type": "meta"}));
        if let Some(existing) = meta.get("delete_token_hash").and_then(|h| h.as_str()) {
            if constant_time_eq(existing.as_bytes(), hash.as_bytes()) {
                return (200, json!({"claimed": true, "already_claimed": true, "delete_token_hash": existing, "room": parts[2]}).to_string());
            }
            return (409, json!({"error": "room already claimed", "delete_token_hash": existing}).to_string());
        }
        let now = effective_now_secs();
        meta["delete_token_hash"] = json!(hash);
        meta["claimed_at"] = json!(now);
        return (200, json!({"claimed": true, "delete_token_hash": hash, "room": parts[2]}).to_string());
    }

    if parts.len() == 4 && parts[3] == "freeze" {
        if let Err(resp) = authorize_token(&guard, &room, body) {
            return resp;
        }
        let min_age = min_claim_age_secs();
        let claimed_at = guard.get(&room)
            .and_then(|r| r.get("@meta"))
            .and_then(|m| m.get("claimed_at"))
            .and_then(|c| c.as_u64())
            .unwrap_or(0);
        let now = effective_now_secs();
        if now.saturating_sub(claimed_at) < min_age {
            return (403, json!({
                "error": "minimum claim age not met; try again later",
                "claimed_at": claimed_at,
                "min_claim_age_seconds": min_age
            }).to_string());
        }
        let room_data = guard.get_mut(&room).unwrap();
        let meta = room_data.entry("@meta".to_string()).or_insert_with(|| json!({"@type": "meta"}));
        meta["frozen_at"] = json!(now);
        return (200, json!({"frozen": true, "frozen_at": now}).to_string());
    }

    if parts.len() == 4 && parts[3] == "delete" {
        if let Err(resp) = authorize_token(&guard, &room, body) {
            return resp;
        }
        let min_age = min_claim_age_secs();
        let claimed_at = guard.get(&room)
            .and_then(|r| r.get("@meta"))
            .and_then(|m| m.get("claimed_at"))
            .and_then(|c| c.as_u64())
            .unwrap_or(0);
        let now = effective_now_secs();
        if now.saturating_sub(claimed_at) < min_age {
            return (403, json!({
                "error": "minimum claim age not met; try again later",
                "claimed_at": claimed_at,
                "min_claim_age_seconds": min_age
            }).to_string());
        }
        let room_data = guard.get_mut(&room).unwrap();
        let meta = room_data.entry("@meta".to_string()).or_insert_with(|| json!({"@type": "meta"}));
        meta["soft_deleted_at"] = json!(now);
        return (200, json!({"soft_deleted": true, "purge_after_seconds": 604800}).to_string());
    }

    if parts.len() == 4 && parts[3] == "undelete" {
        if let Err(resp) = authorize_token(&guard, &room, body) {
            return resp;
        }
        let room_data = guard.get_mut(&room).unwrap();
        if let Some(meta) = room_data.get_mut("@meta").and_then(|m| m.as_object_mut()) {
            meta.remove("soft_deleted_at");
        }
        return (200, json!({"soft_deleted": false, "undeleted": true}).to_string());
    }

    match (method,parts.len()) {
        ("PUT",5) if identifier(parts[4]) => {
            if body.len()>MAX_BODY {return (413,json!({"error":"batch exceeds 1 MB"}).to_string());}
            if guard.get(&room).and_then(|r| r.get("@meta")).and_then(|m| m.get("frozen_at")).is_some() {
                return (409, json!({"error": "room is frozen"}).to_string());
            }
            let mut blob: Value = match serde_json::from_str(body) {Ok(v)=>v,Err(_)=>return (400,json!({"error":"invalid JSON"}).to_string())};
            if blob.get("v")!=Some(&json!(1)) || !blob.get("nonce").is_some_and(|v|v.as_str().is_some_and(|s|!s.is_empty() && s.len()<=256)) || !blob.get("ct").is_some_and(|v|v.as_str().is_some_and(|s|!s.is_empty())) || blob.as_object().is_none_or(|m|m.len()!=3) {
                return (400,json!({"error":"invalid sealed batch"}).to_string());
            }

            let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
            let hash_opt = query.split('&').find_map(|p| p.strip_prefix("delete_token_hash="));
            if let Some(hash_val) = hash_opt {
                if hash_val.len() != 64 || !hash_val.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return (400, json!({"error": "invalid delete token hash format"}).to_string());
                }
                let lower_hash = hash_val.to_ascii_lowercase();
                let room_map = guard.entry(room.clone()).or_default();
                let meta = room_map.entry("@meta".to_string()).or_insert_with(|| json!({"@type": "meta"}));
                if let Some(existing) = meta.get("delete_token_hash").and_then(|h| h.as_str()) {
                    if !constant_time_eq(existing.as_bytes(), lower_hash.as_bytes()) {
                        return (409, json!({"error": "delete token hash mismatch"}).to_string());
                    }
                } else {
                    meta["delete_token_hash"] = json!(lower_hash);
                    meta["claimed_at"] = json!(effective_now_secs());
                }
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

pub const POLL_TIMEOUT: Duration = Duration::from_secs(25);
pub const POLL_INTERVAL: Duration = Duration::from_millis(250);

pub fn current_version(versions: &Versions, room: &str) -> u64 {
    versions.lock().unwrap().get(room).copied().unwrap_or(0)
}

pub fn parse_since(path: &str) -> u64 {
    path.split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .find_map(|kv| kv.strip_prefix("since="))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

pub fn wait_for_change(versions: &Versions, room: &str, since: u64, timeout: Duration, interval: Duration) -> u64 {
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
