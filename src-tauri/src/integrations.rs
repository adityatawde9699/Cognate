use serde::{Deserialize, Serialize};
use reqwest::Client;

#[derive(Debug, Serialize, Deserialize)]
pub struct SlackPayload {
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiscordPayload {
    pub content: String,
}

#[tauri::command]
pub async fn send_notification(platform: String, url_or_token: String, message: String) -> Result<(), String> {
    let client = Client::new();

    match platform.as_str() {
        "slack" => {
            let payload = SlackPayload { text: message };
            client.post(&url_or_token)
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("Slack error: {}", e))?;
            Ok(())
        }
        "discord" => {
            let payload = DiscordPayload { content: message };
            client.post(&url_or_token)
                .json(&payload)
                .send()
                .await
                .map_err(|e| format!("Discord error: {}", e))?;
            Ok(())
        }
        _ => Err("Unknown platform".into()),
    }
}

/// Fetch a remote iCalendar (.ics) feed and return its raw text.
/// The browser fallback can't do this (CORS), so the subscription
/// feature is a desktop affordance; parsing happens in TS.
#[tauri::command]
pub async fn fetch_ics(url: String) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://") || u.starts_with("webcal://")) {
        return Err("Only http(s) / webcal calendar URLs are supported".into());
    }
    // webcal:// is just https:// for our purposes.
    let fetch_url = u.replacen("webcal://", "https://", 1);
    let client = Client::new();
    let resp = client
        .get(&fetch_url)
        .header("User-Agent", "Cognate/1.0")
        .send()
        .await
        .map_err(|e| format!("Calendar fetch failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Calendar server returned {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("Reading calendar failed: {}", e))
}

/// Minimal HTTP transport for the E2E-encrypted sync relay. The body it carries
/// is always ciphertext (sealed client-side), so this command never sees plaintext.
#[tauri::command]
pub async fn relay_fetch(method: String, url: String, body: Option<String>, token: Option<String>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("Relay URL must be http(s)".into());
    }
    let client = Client::new();
    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(u),
        "PUT" => client.put(u).header("Content-Type", "application/json").body(body.unwrap_or_default()),
        "POST" => client.post(u).header("Content-Type", "application/json").body(body.unwrap_or_default()),
        other => return Err(format!("Unsupported method: {}", other)),
    };
    // Optional bearer token for a gated relay (never a decryption key).
    if let Some(t) = token.filter(|t| !t.is_empty()) {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await.map_err(|e| format!("Relay request failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Relay returned {}", resp.status()));
    }
    resp.text().await.map_err(|e| format!("Reading relay response failed: {}", e))
}

/// OAuth 2.0 token endpoint (authorization-code exchange or refresh). PKCE, so
/// there's no client secret. Returns the raw JSON token response.
#[tauri::command]
pub async fn oauth_token(token_url: String, form: std::collections::HashMap<String, String>) -> Result<String, String> {
    let client = Client::new();
    let resp = client.post(&token_url).form(&form).send().await.map_err(|e| format!("Token request failed: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Reading token response failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Token endpoint returned {}: {}", status, text));
    }
    Ok(text)
}

/// A bearer-authenticated calendar API call (read-only free/busy). GET or POST
/// JSON. Sends `Prefer: outlook.timezone="UTC"` so Microsoft returns UTC times.
#[tauri::command]
pub async fn oauth_api(method: String, url: String, token: String, body: String) -> Result<String, String> {
    let client = Client::new();
    let req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url).header("Content-Type", "application/json").body(body),
        other => return Err(format!("Unsupported method: {}", other)),
    };
    let resp = req
        .bearer_auth(&token)
        .header("Prefer", "outlook.timezone=\"UTC\"")
        .send().await.map_err(|e| format!("Calendar API request failed: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Reading calendar response failed: {}", e))?;
    if !status.is_success() {
        return Err(format!("Calendar API returned {}: {}", status, text));
    }
    Ok(text)
}

#[tauri::command]
pub async fn start_oauth(provider: String) -> Result<String, String> {
     // A mock implementation of the port binding for the plugin.
     // The frontend would listen to the tauri://oauth plugin events.
     tauri_plugin_oauth::start(move |url| {
        // The URL is passed back to the frontend via an event
        println!("Received auth code via URL: {}", url);
    })
    .map_err(|e| e.to_string())?;

    // In a real flow, we generate the PKCE Auth URL and return it
    let auth_url = match provider.as_str() {
        "google" => {
            let client_id = std::env::var("GOOGLE_CLIENT_ID").unwrap_or_else(|_| "YOUR_CLIENT_ID".to_string());
            format!("https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/calendar", client_id)
        },
        "microsoft" => {
            let client_id = std::env::var("MICROSOFT_CLIENT_ID").unwrap_or_else(|_| "YOUR_CLIENT_ID".to_string());
            format!("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id={}&response_type=code&redirect_uri=http://localhost&scope=Calendars.ReadWrite", client_id)
        },
        _ => return Err("Invalid provider".into()),
    };

    Ok(auth_url)
}

#[cfg(test)]
mod tests {
    use super::fetch_ics;

    /// `fetch_ics` rejects non-http(s)/webcal URLs before touching the network.
    #[test]
    fn fetch_ics_rejects_unsupported_schemes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        for bad in ["file:///etc/passwd", "ftp://host/cal.ics", "not-a-url"] {
            let err = rt.block_on(fetch_ics(bad.to_string())).unwrap_err();
            assert!(err.contains("supported"), "expected scheme rejection for {bad}, got: {err}");
        }
    }
}
