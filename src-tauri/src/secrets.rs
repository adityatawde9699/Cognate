//! OS-keychain secret storage for sensitive settings
//! (Anthropic API key, Slack/Discord webhook URLs).
//!
//! Backed by the `keyring` crate (Secret Service on Linux, Keychain on
//! macOS, Credential Manager on Windows). Only absent credentials return
//! `None`; unavailable/locked backends return errors. The frontend must never
//! interpret a backend failure as a missing identity or write plaintext.

const SERVICE: &str = "cognate";

fn entry(app: &tauri::AppHandle, key: &str) -> Result<keyring::Entry, keyring::Error> {
    // Preserve production credentials while isolating differently identified
    // test builds from the user's real signing identity and provider tokens.
    let identifier = &app.config().identifier;
    let service = if identifier == "com.cognate.app" { SERVICE } else { identifier };
    keyring::Entry::new(service, key)
}

/// Read a secret from the OS keychain. Returns `None` if unset or
/// if the platform backend is unavailable.
#[tauri::command]
pub fn secret_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    match entry(&app, &key) {
        Ok(e) => match e.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => {
                log::warn!("secret_get({key}) failed: {err}");
                Err(format!("secure storage read failed: {err}"))
            }
        },
        Err(err) => {
            log::warn!("secret_get entry({key}) failed: {err}");
            Err(format!("secure storage unavailable: {err}"))
        }
    }
}

/// Write (or clear, when `value` is empty) a secret in the OS keychain.
#[tauri::command]
pub fn secret_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let e = entry(&app, &key).map_err(|err| format!("keychain unavailable: {err}"))?;
    if value.is_empty() {
        match e.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(format!("failed to clear secret: {err}")),
        }
    } else {
        e.set_password(&value)
            .map_err(|err| format!("failed to store secret: {err}"))
    }
}
