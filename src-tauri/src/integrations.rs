use serde::{Deserialize, Serialize};
use reqwest::Client;
fn http_client() -> Result<Client,String> {
    Client::builder().connect_timeout(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())
}
async fn bounded_text(mut response:reqwest::Response,limit:usize)->Result<String,String> {
    if response.content_length().is_some_and(|n|n>limit as u64) {return Err("Calendar response exceeds size limit".into());}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|e|e.to_string())? {
        if bytes.len()+chunk.len()>limit {return Err("Calendar response exceeds size limit".into());}
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|e|e.to_string())
}

fn calendar_endpoint(url:&str, token:bool) -> Result<(),String> {
    let parsed=reqwest::Url::parse(url).map_err(|e|e.to_string())?;
    if parsed.scheme()!="https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some_and(|p|p!=443) || parsed.fragment().is_some() {return Err("Unsupported calendar endpoint".into());}
    let allowed = if token {
        ["https://oauth2.googleapis.com/token","https://login.microsoftonline.com/common/oauth2/v2.0/token"].contains(&url)
    } else {
        (parsed.host_str()==Some("www.googleapis.com") && parsed.path()=="/calendar/v3/freeBusy") ||
        (parsed.host_str()==Some("graph.microsoft.com") && parsed.path()=="/v1.0/me/calendarView")
    };
    if !allowed {return Err("Unsupported calendar endpoint".into());} Ok(())
}

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
    let client = http_client()?;

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
    let client = http_client()?;
    let resp = client
        .get(&fetch_url)
        .header("User-Agent", "Cognate/1.0")
        .send()
        .await
        .map_err(|e| format!("Calendar fetch failed: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Calendar server returned {}", resp.status()));
    }
    bounded_text(resp,1_000_000).await
}

/// Minimal HTTP transport for the E2E-encrypted sync relay. The body it carries
/// is always ciphertext (sealed client-side), so this command never sees plaintext.
#[tauri::command]
pub async fn relay_fetch(method: String, url: String, body: Option<String>, token: Option<String>) -> Result<String, String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("Relay URL must be http(s)".into());
    }
    let parsed=reqwest::Url::parse(u).map_err(|e|e.to_string())?;
    let loopback=matches!(parsed.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"));
    if (parsed.scheme()!="https" && !(parsed.scheme()=="http" && loopback)) || !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {return Err("Relay requires HTTPS or loopback HTTP".into());}
    let client = http_client()?;
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
    calendar_endpoint(&token_url,true)?;
    let client = http_client()?;
    let resp = client.post(&token_url).form(&form).send().await.map_err(|e| format!("Token request failed: {}", e))?;
    let status = resp.status();
    let text = bounded_text(resp,64_000).await?;
    if !status.is_success() {
        return Err(format!("Token endpoint returned {}", status));
    }
    Ok(text)
}

/// A bearer-authenticated calendar API call (read-only free/busy). GET or POST
/// JSON. Sends `Prefer: outlook.timezone="UTC"` so Microsoft returns UTC times.
#[tauri::command]
pub async fn oauth_api(method: String, url: String, token: String, body: String) -> Result<String, String> {
    calendar_endpoint(&url,false)?;
    if !((url.starts_with("https://www.googleapis.com/") && method=="POST") || (url.starts_with("https://graph.microsoft.com/") && method=="GET")) {return Err("Unsupported calendar operation".into());}
    let client = http_client()?;
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
    let text = bounded_text(resp,2_000_000).await?;
    if !status.is_success() {
        return Err(format!("Calendar API returned {}", status));
    }
    Ok(text)
}


struct OAuthSession {cancel:std::sync::Arc<std::sync::atomic::AtomicBool>,finished:std::sync::Arc<std::sync::atomic::AtomicBool>}
static OAUTH_CANCEL: std::sync::Mutex<Option<OAuthSession>> = std::sync::Mutex::new(None);

fn valid_callback(target:&str, state:&str) -> bool {
    let Ok(url)=reqwest::Url::parse(&format!("http://127.0.0.1:8788{target}")) else {return false;};
    let states:Vec<_>=url.query_pairs().filter(|(k,_)|k=="state").map(|(_,v)|v.to_string()).collect();
    url.path()=="/callback" && states.len()==1 && states[0]==state && url.fragment().is_none()
}

/// Bind before opening consent. Only a callback with the exact state/path is
/// handed to the UI; unrelated local requests cannot consume the listener.
#[tauri::command]
pub async fn start_oauth(app:tauri::AppHandle,state:String) -> Result<u16,String> {
    use std::sync::atomic::{AtomicBool,Ordering};
    use tauri::Emitter;
    if state.len()<32 || state.len()>128 || !state.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-' || b==b'_') {return Err("Invalid OAuth state".into());}
    let mut slot=OAUTH_CANCEL.lock().map_err(|e|e.to_string())?;
    if slot.as_ref().is_some_and(|flag|!flag.finished.load(Ordering::SeqCst)) {return Err("Calendar sign-in already in progress. Cancel it first.".into());}
    let listener=std::net::TcpListener::bind("127.0.0.1:8788").map_err(|e|format!("Cannot open calendar callback: {e}"))?;
    listener.set_nonblocking(true).map_err(|e|e.to_string())?;
    let flag=std::sync::Arc::new(AtomicBool::new(false));let finished=std::sync::Arc::new(AtomicBool::new(false)); *slot=Some(OAuthSession {cancel:flag.clone(),finished:finished.clone()});
    std::thread::spawn(move || {
        use std::io::{Read,Write};
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(600);
        while !flag.load(Ordering::SeqCst) && std::time::Instant::now()<deadline {
            match listener.accept() {
                Ok((mut stream,_))=>{
                    let _=stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
                    let _=stream.set_write_timeout(Some(std::time::Duration::from_secs(2)));
                    let mut buffer=[0u8;4096]; let mut size=0;
                    while size<buffer.len() {
                        match stream.read(&mut buffer[size..]) {Ok(0)|Err(_)=>break,Ok(n)=>{size+=n;if buffer[..size].windows(4).any(|w|w==b"\r\n\r\n") {break;}}}
                    }
                    let request=String::from_utf8_lossy(&buffer[..size]);
                    let mut first=request.lines().next().unwrap_or("").split_whitespace();
                    let method=first.next().unwrap_or(""); let target=first.next().unwrap_or("");
                    let host=request.lines().any(|line|line.split_once(':').is_some_and(|(name,value)|name.eq_ignore_ascii_case("host") && value.trim()=="127.0.0.1:8788"));
                    let valid=method=="GET" && host && valid_callback(target,&state) && !flag.load(Ordering::SeqCst);
                    let response=if valid {"HTTP/1.1 200 OK\r\nContent-Length: 32\r\nConnection: close\r\n\r\nSign-in received. Return to app."} else {"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"};
                    let _=stream.write_all(response.as_bytes());
                    if valid {let _=app.emit("calendar-oauth-callback",format!("http://127.0.0.1:8788{target}"));break;}
                },
                Err(error) if error.kind()==std::io::ErrorKind::WouldBlock=>std::thread::sleep(std::time::Duration::from_millis(50)),
                Err(_)=>break,
            }
        }
        drop(listener);flag.store(true,Ordering::SeqCst);finished.store(true,Ordering::SeqCst);
    });
    Ok(8788)
}
#[tauri::command]
pub async fn cancel_oauth() -> Result<(),String> {
    let finished={
        let slot=OAUTH_CANCEL.lock().map_err(|e|e.to_string())?;
        slot.as_ref().map(|session|{session.cancel.store(true,std::sync::atomic::Ordering::SeqCst);session.finished.clone()})
    };
    if let Some(finished)=finished {
        for _ in 0..150 {if finished.load(std::sync::atomic::Ordering::SeqCst) {return Ok(());}tokio::time::sleep(std::time::Duration::from_millis(20)).await;}
        return Err("Calendar callback is still closing. Retry shortly.".into());
    }
    Ok(())
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
    #[test]
    fn calendar_tokens_cannot_be_sent_to_arbitrary_endpoints() {
        for bad in ["http://oauth2.googleapis.com/token","https://oauth2.googleapis.com.evil/token","https://evil.example/token","https://user@oauth2.googleapis.com/token"] {assert!(super::calendar_endpoint(bad,true).is_err());}
        assert!(super::calendar_endpoint("https://oauth2.googleapis.com/token",true).is_ok());
        assert!(super::calendar_endpoint("https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=x",false).is_ok());
        assert!(super::calendar_endpoint("https://graph.microsoft.com/v1.0/me/messages",false).is_err());
    }

    #[test]
    fn callback_admission_requires_exact_path_and_single_state() {
        assert!(super::valid_callback("/callback?code=approved&state=expected","expected"));
        for target in ["/callback?state=wrong","/callback?state=expected&state=expected","/foreign?state=expected","/callback?state=expected#fragment"] {assert!(!super::valid_callback(target,"expected"));}
    }

}
