use std::collections::HashMap;
use std::sync::Mutex;
use tiny_http::Header;

pub struct Bucket {
    pub window_start: u64,
    pub count: u32,
}
pub type RateMap = Mutex<HashMap<String, Bucket>>;

pub fn ip_budget_key(ip: &str) -> String {
    if let Ok(addr) = ip.parse::<std::net::IpAddr>() {
        match addr {
            std::net::IpAddr::V4(v4) => v4.to_string(),
            std::net::IpAddr::V6(v6) => {
                let segs = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", segs[0], segs[1], segs[2], segs[3])
            }
        }
    } else {
        ip.to_string()
    }
}

/// Returns true if the request is allowed; counts it against the window.
pub fn rate_ok(rate: &RateMap, ip: &str, now: u64, limit: u32, window: u64) -> bool {
    let key = ip_budget_key(ip);
    let mut m = rate.lock().unwrap();
    if m.len() >= 10000 {
        m.retain(|_, bucket| now.saturating_sub(bucket.window_start) < window);
        if m.len() >= 10000 && !m.contains_key(&key) {
            if let Some(oldest_key) = m.iter().min_by_key(|(_, b)| b.window_start).map(|(k, _)| k.clone()) {
                m.remove(&oldest_key);
            }
        }
    }
    let b = m.entry(key).or_insert(Bucket { window_start: now, count: 0 });
    if now.saturating_sub(b.window_start) >= window {
        b.window_start = now;
        b.count = 0;
    }
    b.count = b.count.saturating_add(1);
    b.count <= limit
}

pub fn resolve_client_ip(socket_ip: &str, headers: &[Header], trusted_hops: usize) -> String {
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
