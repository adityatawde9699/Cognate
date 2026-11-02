use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tiny_http::Header;
use serde_json::{json, Value};
use crate::store::Data;

pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in result {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    hex
}

/// Compare two byte slices in constant time to prevent timing attacks against tokens.
/// Note: timing guarantees cannot be unit-tested portably; the guarantee rests on the
/// subtle crate's ConstantTimeEq trait contract.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.ct_eq(b).into()
}

pub fn bearer_ok(headers: &[Header], expected: &str) -> bool {
    if expected.is_empty() {
        return true; // no token configured → open
    }
    let want = format!("Bearer {expected}");
    headers
        .iter()
        .any(|h| h.field.equiv("Authorization") && constant_time_eq(h.value.as_str().trim().as_bytes(), want.as_bytes()))
}

pub fn authorize_token(guard: &Data, room: &str, body: &str) -> Result<String, (u16, String)> {
    let token = match serde_json::from_str::<Value>(body) {
        Ok(v) => v.get("delete_token").and_then(|t| t.as_str()).map(|s| s.to_string()),
        Err(_) => None,
    };
    let token = match token {
        Some(t) if !t.is_empty() => t,
        _ => return Err((400, json!({"error": "missing delete_token"}).to_string())),
    };

    let token_hash = sha256_hex(token.as_bytes());
    let stored_hash = guard.get(room)
        .and_then(|r| r.get("@meta"))
        .and_then(|m| m.get("delete_token_hash"))
        .and_then(|h| h.as_str());

    let (is_match, auth_ok) = match stored_hash {
        Some(h) => (constant_time_eq(token_hash.as_bytes(), h.as_bytes()), true),
        None => {
            let dummy = "0000000000000000000000000000000000000000000000000000000000000000";
            let _ = constant_time_eq(token_hash.as_bytes(), dummy.as_bytes());
            (false, false)
        }
    };

    if !auth_ok || !is_match {
        return Err((403, json!({"error": "unauthorized"}).to_string()));
    }

    Ok(token)
}
