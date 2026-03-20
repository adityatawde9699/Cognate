use tauri_plugin_sql::{Migration, MigrationKind};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use chrono::{NaiveDate, Utc};

mod integrations;

struct PomoState {
    time_left: u32,
    is_active: bool,
}

pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create_initial_schema",
        sql: include_str!("../migrations/001_init.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        .manage(std::sync::Mutex::new(PomoState {
            time_left: 25 * 60,
            is_active: false,
        }))
        // ── Plugins ──────────────────────────────────
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:cognote.db", migrations)
                .build(),
        )
        // ── System Tray (M7) ─────────────────────────
        .setup(|app| {
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Show Cognote", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        // ── Commands ─────────────────────────────────
        .invoke_handler(tauri::generate_handler![
            app_ready,
            calc_priority,
            toggle_pomodoro,
            reset_pomodoro,
            integrations::send_notification,
            integrations::start_oauth
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cognote");
}

/// Called by the frontend once the app has mounted.
/// Returns the app version so the titlebar can show it.
#[tauri::command]
fn app_ready() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Priority calculation in Rust (M3)
#[tauri::command]
fn calc_priority(importance: u8, effort: u8, deadline: Option<String>) -> Result<String, String> {
    let imp = (importance as f64 / 5.0) * 4.0;
    
    let deadl = if let Some(dl) = deadline {
        if dl.is_empty() {
            0.0
        } else {
            match NaiveDate::parse_from_str(&dl, "%Y-%m-%d") {
                Ok(parsed_date) => {
                    let now = Utc::now().naive_utc().date();
                    let days_left = parsed_date.signed_duration_since(now).num_days() as f64;
                    
                    if days_left <= 0.0 {
                        4.0
                    } else if days_left <= 14.0 {
                        4.0 * (1.0 - days_left / 14.0)
                    } else {
                        0.0
                    }
                }
                Err(_) => return Err(format!("Invalid deadline format: {}", dl)),
            }
        }
    } else {
        0.0
    };

    let eff = ((6.0 - effort as f64) / 5.0) * 2.0;
    let total = imp + deadl + eff;

    if total >= 6.5 {
        Ok("high".to_string())
    } else if total >= 3.5 {
        Ok("medium".to_string())
    } else {
        Ok("low".to_string())
    }
}

// Pomodoro Timer commands (M3)
#[tauri::command]
fn toggle_pomodoro(app: tauri::AppHandle, state: tauri::State<'_, std::sync::Mutex<PomoState>>) -> Result<bool, String> {
    let mut s = state.lock().unwrap();
    s.is_active = !s.is_active;
    let is_active = s.is_active;
    
    if is_active {
        // Start the background tracking timer
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                
                let (time_left, active) = {
                    let state_mutex = app_clone.state::<std::sync::Mutex<PomoState>>();
                    let mut s_curr = state_mutex.lock().unwrap();
                    if !s_curr.is_active {
                        break;
                    }
                    if s_curr.time_left > 0 {
                        s_curr.time_left -= 1;
                    } else {
                        s_curr.is_active = false;
                    }
                    (s_curr.time_left, s_curr.is_active)
                };
                
                let _ = app_clone.emit("pomo-tick", time_left);
                
                if !active {
                    let _ = app_clone.emit("pomo-finished", ());
                    break;
                }
            }
        });
    }
    
    Ok(is_active)
}

#[tauri::command]
fn reset_pomodoro(state: tauri::State<'_, std::sync::Mutex<PomoState>>) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    s.is_active = false;
    s.time_left = 25 * 60;
    Ok(())
}
