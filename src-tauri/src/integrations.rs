use serde::{Deserialize, Serialize};
use reqwest::Client;
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize)]
pub struct SlackPayload {
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DiscordPayload {
    pub content: String,
}

#[tauri::command]
pub async fn send_notification(platform: String, url_or_token: String, message: String, chat_id: Option<String>) -> Result<(), String> {
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
        "telegram" => {
            if let Some(id) = chat_id {
                let api_url = format!("https://api.telegram.org/bot{}/sendMessage", url_or_token);
                let mut map = HashMap::new();
                map.insert("chat_id", id);
                map.insert("text", message);

                client.post(&api_url)
                    .json(&map)
                    .send()
                    .await
                    .map_err(|e| format!("Telegram error: {}", e))?;
                Ok(())
            } else {
                Err("Chat ID required for Telegram".into())
            }
        }
        _ => Err("Unknown platform".into()),
    }
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
        "google" => "https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/calendar".to_string(),
        "microsoft" => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=Calendars.ReadWrite".to_string(),
        _ => return Err("Invalid provider".into()),
    };

    Ok(auth_url)
}
