use serde::{Deserialize, Serialize};
use serde_json::json;
use reqwest::Client;
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, Notify};
#[derive(Default)]
pub struct AiRequests(Mutex<HashMap<String, Arc<Notify>>>);

#[tauri::command]
pub async fn ai_cancel(request_id: String, requests: tauri::State<'_, AiRequests>) -> Result<(), String> {
    if let Some(request) = requests.0.lock().await.get(&request_id) { request.notify_one(); }
    Ok(())
}

async fn bounded_response(mut response: reqwest::Response) -> Result<String, String> {
    let status = response.status();
    if !status.is_success() { return Err(format!("AI provider rejected the request (HTTP {}). Check configuration and retry.", status.as_u16())); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "AI response could not be read")? {
        if bytes.len() + chunk.len() > 1_048_576 { return Err("AI response exceeds the supported size".into()); }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "AI response is not valid UTF-8".into())
}
fn checked_text(text: String) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 65_536 { return Err("AI returned empty or oversized advice".into()); }
    Ok(text.into())
}
fn http_client() -> Result<Client,String> {
    Client::builder().connect_timeout(std::time::Duration::from_secs(10)).timeout(std::time::Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|e|e.to_string())
}
fn validate_base(base:&str) -> Result<(),String> {
    let url=reqwest::Url::parse(base).map_err(|e|e.to_string())?;
    let local=url.host_str().is_some_and(|host|host=="localhost" || host=="[::1]" || host.parse::<std::net::IpAddr>().is_ok_and(|ip|ip.is_loopback()));
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() || url.query().is_some() || !(url.scheme()=="https" || (url.scheme()=="http" && local)) {
        return Err("AI endpoints require HTTPS or a loopback HTTP server, without URL credentials".into());
    }
    Ok(())
}

/// Default Claude model for the Anthropic provider.
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-4-8";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArgs {
    pub api_key: String,
    pub request_id: Option<String>,
    /// "anthropic" | "openai" | "openrouter" | "groq" | "xai" | "gemini" | "deepseek" | "ollama" | "custom"
    pub provider: Option<String>,
    /// Overrides the provider's default base URL (required for "custom").
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub system: Option<String>,
    pub prompt: String,
    pub max_tokens: Option<u32>,
}

/// Resolve the OpenAI-compatible base URL for a named provider.
fn default_base_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "groq" => Some("https://api.groq.com/openai/v1"),
        "xai" => Some("https://api.x.ai/v1"),
        "gemini" => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        "ollama" => Some("http://localhost:11434/v1"),
        "llamacpp" => Some("http://localhost:8080/v1"),
        _ => None,
    }
}

/// Whether a provider can run without an API key (local servers).
fn key_optional(provider: &str) -> bool {
    matches!(provider, "ollama" | "llamacpp" | "custom")
}

/// Generic single-shot completion. Routes to the Anthropic Messages API or an
/// OpenAI-compatible /chat/completions endpoint depending on the provider.
#[tauri::command]
pub async fn ai_generate(args: AiArgs, requests: tauri::State<'_, AiRequests>) -> Result<String, String> {
    if args.prompt.len() > 262_144 || args.system.as_ref().is_some_and(|s| s.len() > 32_768) || args.api_key.len() > 8192 || args.model.as_ref().is_some_and(|s| s.len() > 128) {
        return Err("AI request exceeds the supported size".into());
    }
    let Some(id) = args.request_id.clone() else { return generate_inner(args).await; };
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') { return Err("Invalid AI request identifier".into()); }
    let notify = Arc::new(Notify::new());
    {
        let mut active = requests.0.lock().await;
        if active.len() >= 32 || active.contains_key(&id) { return Err("AI request already active or capacity exhausted".into()); }
        active.insert(id.clone(), notify.clone());
    }
    let result = tokio::select! {
        response = generate_inner(args) => response,
        _ = notify.notified() => Err("AI request cancelled".into()),
    };
    requests.0.lock().await.remove(&id);
    result
}
async fn generate_inner(args: AiArgs) -> Result<String, String> {
    let provider = args
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or("anthropic")
        .to_lowercase();

    let api_key = args.api_key.trim().to_string();
    if api_key.is_empty() && !key_optional(&provider) {
        return Err("No API key set. Add one in Settings → AI.".into());
    }

    let max_tokens = args.max_tokens.unwrap_or(1024).clamp(256, 8192);
    let system = args.system.as_deref().map(str::trim).filter(|s| !s.is_empty());

    if provider == "anthropic" {
        let model = args
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .unwrap_or(DEFAULT_ANTHROPIC_MODEL);
        anthropic(&api_key, model, system, &args.prompt, max_tokens).await
    } else {
        let base = args
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(|b| b.to_string())
            .or_else(|| default_base_url(&provider).map(|s| s.to_string()))
            .ok_or_else(|| format!("No base URL configured for provider '{provider}'."))?;
        let model = args
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .ok_or("Set a model name for this provider in Settings → AI.")?;
        openai_compatible(&base, &api_key, model, system, &args.prompt, max_tokens).await
    }
}

// ── Anthropic ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct AnthropicResponse { content: Vec<ContentBlock>, #[serde(default)] stop_reason: Option<String> }
#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: String,
}
async fn anthropic(
    api_key: &str,
    model: &str,
    system: Option<&str>,
    prompt: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{ "role": "user", "content": prompt }],
    });
    if let Some(system) = system {
        body["system"] = json!(system);
    }

    let resp = http_client()?
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|_| "AI provider is unreachable or timed out")?;

    let raw = bounded_response(resp).await?;
    parse_anthropic(&raw)
}
fn parse_anthropic(raw: &str) -> Result<String,String> {
    let parsed: AnthropicResponse = serde_json::from_str(raw).map_err(|_| "Invalid AI provider response")?;
    if parsed.stop_reason.as_deref() == Some("max_tokens") { return Err("AI response was truncated. Request fewer tasks.".into()); }
    let text = parsed
        .content
        .into_iter()
        .filter(|b| b.block_type == "text")
        .map(|b| b.text)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    checked_text(text)
}

// ── OpenAI-compatible (OpenAI, OpenRouter, Groq, xAI, Gemini, DeepSeek, Ollama, llama.cpp, custom) ──

#[derive(Debug, Deserialize)]
struct OpenAiResponse { choices: Vec<OpenAiChoice> }
#[derive(Debug, Deserialize)]
struct OpenAiChoice { message: OpenAiMessage, #[serde(default)] finish_reason: Option<String> }
#[derive(Debug, Deserialize)]
struct OpenAiMessage {
    #[serde(default)]
    content: Option<String>,
}

async fn openai_compatible(
    base_url: &str,
    api_key: &str,
    model: &str,
    system: Option<&str>,
    prompt: &str,
    max_tokens: u32,
) -> Result<String, String> {
    validate_base(base_url)?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut messages = Vec::new();
    if let Some(system) = system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));

    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
    });

    let mut req = http_client()?
        .post(&url)
        .header("content-type", "application/json");
    if !api_key.is_empty() {
        req = req.header("authorization", format!("Bearer {api_key}"));
    }

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|_| "AI provider is unreachable or timed out")?;

    let raw = bounded_response(resp).await?;
    parse_openai(&raw)
}
fn parse_openai(raw: &str) -> Result<String,String> {
    let parsed: OpenAiResponse = serde_json::from_str(raw).map_err(|_| "Invalid AI provider response")?;
    if parsed.choices.len() != 1 || parsed.choices.iter().any(|c| c.finish_reason.as_deref().is_some_and(|r| r != "stop")) { return Err("AI response was incomplete or refused. Your plan is preserved.".into()); }
    let text = parsed
        .choices
        .into_iter()
        .filter_map(|c| c.message.content)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    checked_text(text)
}

#[cfg(test)]
mod endpoint_tests {
    use super::*;
    #[test]
    fn provider_envelopes_reject_truncation_refusal_empty_and_malformed_content() {
        assert_eq!(parse_anthropic(r#"{"content":[{"type":"text","text":"[]"}],"stop_reason":"end_turn"}"#).unwrap(),"[]");
        assert_eq!(parse_openai(r#"{"choices":[{"message":{"content":"[]"},"finish_reason":"stop"}]}"#).unwrap(),"[]");
        for response in [r#"{"choices":[]}"#,r#"{"choices":[{"message":{"content":null}}]}"#,r#"{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}"#,r#"{"error":{"message":"private-secret"}}"#] {
            let error=parse_openai(response).unwrap_err(); assert!(!error.contains("private-secret"));
        }
        assert!(parse_anthropic(r#"{"content":[{"type":"text","text":"partial"}],"stop_reason":"max_tokens"}"#).is_err());
        assert!(checked_text("x".repeat(65_537)).is_err());
    }
    fn server_response(status: &str, body: String) -> String {
        use std::io::{Read, Write};
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap(); let status=status.to_owned();
        std::thread::spawn(move || {
            let (mut stream,_)=listener.accept().unwrap(); stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            let mut request=[0;8192]; let _=stream.read(&mut request);
            let response=format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n{body}",body.len());
            let _=stream.write_all(response.as_bytes());
        });
        format!("http://{address}/v1")
    }
    #[tokio::test]
    async fn native_http_enforces_response_size_and_redacts_error_bodies() {
        let base=server_response("200 OK",r#"{"choices":[{"message":{"content":"[]"},"finish_reason":"stop"}]}"#.into());
        assert_eq!(openai_compatible(&base,"test-key","test-model",None,"synthetic",256).await.unwrap(),"[]");
        let base=server_response("401 Unauthorized","private-key-and-task-title".into());
        let error=openai_compatible(&base,"test-key","test-model",None,"synthetic",256).await.unwrap_err();
        assert!(error.contains("401")); assert!(!error.contains("private-key"));
        let base=server_response("200 OK","x".repeat(1_048_577));
        assert!(openai_compatible(&base,"test-key","test-model",None,"synthetic",256).await.unwrap_err().contains("supported size"));
    }
    #[test]
    fn credentials_only_go_to_tls_or_loopback_without_redirects() {
        for url in ["https://models.example/v1","http://localhost:11434/v1","http://127.0.0.1:8080/v1","http://[::1]:8080/v1"] {assert!(super::validate_base(url).is_ok());}
        for url in ["http://models.example/v1","http://localhost.evil.example/v1","https://user:password@models.example/v1","file:///tmp/model"] {assert!(super::validate_base(url).is_err());}
    }
}
