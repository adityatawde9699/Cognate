//! Explicit, reversible probes. No task contents or existing credentials read.
use std::{fs, io::Write};
use tauri::Manager;

#[tauri::command]
pub fn desktop_process_id() -> u32 { std::process::id() }

#[derive(serde::Serialize)]
pub struct HealthCheck { check: &'static str, passed: bool }

#[tauri::command]
pub fn desktop_health(app: tauri::AppHandle) -> Vec<HealthCheck> {
    let nonce = format!("{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    let window = app.get_webview_window("main");
    let window_ok = window.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false) && w.title().is_ok());
    let tray_ok = app.tray_by_id("main-tray").is_some();
    let key = format!("diagnostic-{nonce}");
    let keychain_ok = (|| -> Result<bool, String> {
        crate::secrets::secret_set(app.clone(), key.clone(), "cognate-diagnostic-probe".into())?;
        let result = crate::secrets::secret_get(app.clone(), key.clone());
        let cleanup = crate::secrets::secret_set(app.clone(), key.clone(), String::new());
        Ok(result? == Some("cognate-diagnostic-probe".into()) && cleanup.is_ok())
    })().unwrap_or(false);
    let filesystem_ok = (|| -> Result<bool, std::io::Error> {
        let folder = app.path().app_cache_dir().map_err(std::io::Error::other)?;
        fs::create_dir_all(&folder)?;
        let path = folder.join(format!("diagnostic-{nonce}.tmp"));
        let result = (|| {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
            file.write_all(b"cognate-diagnostic-probe")?; file.sync_all()?; drop(file);
            Ok(fs::read(&path)? == b"cognate-diagnostic-probe")
        })();
        let cleanup = fs::remove_file(&path);
        result.map(|passed| passed && cleanup.is_ok())
    })().unwrap_or(false);
    vec![HealthCheck {check:"window",passed:window_ok}, HealthCheck {check:"tray",passed:tray_ok},
        HealthCheck {check:"keychain",passed:keychain_ok}, HealthCheck {check:"filesystem",passed:filesystem_ok}]
}
