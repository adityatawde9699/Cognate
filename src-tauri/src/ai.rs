use serde::{Deserialize, Serialize};
use serde_json::json;
use reqwest::Client;

/// Default Claude model for the Anthropic provider.
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-opus-4-8";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiArgs {
    pub api_key: String,
    /// "anthropic" | "openai" | "openrouter" | "groq" | "xai" | "gemini" | "ollama" | "custom"
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
pub async fn ai_generate(args: AiArgs) -> Result<String, String> {
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
struct AnthropicResponse { content: Vec<ContentBlock> }
#[derive(Debug, Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    #[serde(default)]
    text: String,
}
#[derive(Debug, Deserialize)]
struct ApiError { error: ApiErrorBody }
#[derive(Debug, Deserialize)]
struct ApiErrorBody { message: String }

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

    let resp = Client::new()
        .post(ANTHROPIC_URL)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error contacting Claude: {e}"))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("Failed to read response: {e}"))?;

    if !status.is_success() {
        if let Ok(parsed) = serde_json::from_str::<ApiError>(&raw) {
            return Err(format!("Claude API error ({status}): {}", parsed.error.message));
        }
        return Err(format!("Claude API error ({status}): {raw}"));
    }

    let parsed: AnthropicResponse =
        serde_json::from_str(&raw).map_err(|e| format!("Could not parse Claude response: {e}"))?;
    let text = parsed
        .content
        .into_iter()
        .filter(|b| b.block_type == "text")
        .map(|b| b.text)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("Claude returned an empty response.".into());
    }
    Ok(text)
}

// ── OpenAI-compatible (OpenAI, OpenRouter, Groq, xAI, Gemini, Ollama, llama.cpp, custom) ──

#[derive(Debug, Deserialize)]
struct OpenAiResponse { choices: Vec<OpenAiChoice> }
#[derive(Debug, Deserialize)]
struct OpenAiChoice { message: OpenAiMessage }
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

    let mut req = Client::new()
        .post(&url)
        .header("content-type", "application/json");
    if !api_key.is_empty() {
        req = req.header("authorization", format!("Bearer {api_key}"));
    }

    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error contacting {url}: {e}"))?;

    let status = resp.status();
    let raw = resp.text().await.map_err(|e| format!("Failed to read response: {e}"))?;

    if !status.is_success() {
        if let Ok(parsed) = serde_json::from_str::<ApiError>(&raw) {
            return Err(format!("AI API error ({status}): {}", parsed.error.message));
        }
        return Err(format!("AI API error ({status}): {raw}"));
    }

    let parsed: OpenAiResponse =
        serde_json::from_str(&raw).map_err(|e| format!("Could not parse response: {e}"))?;
    let text = parsed
        .choices
        .into_iter()
        .filter_map(|c| c.message.content)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();

    if text.is_empty() {
        return Err("The model returned an empty response.".into());
    }
    Ok(text)
}
