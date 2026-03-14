use tauri_plugin_sql::{Migration, MigrationKind};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn run() {
    let migrations = vec![Migration {
        version: 1,
        description: "create_initial_schema",
        sql: include_str!("../migrations/001_init.sql"),
        kind: MigrationKind::Up,
    }];

    tauri::Builder::default()
        // ── Plugins ──────────────────────────────────
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
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
        .invoke_handler(tauri::generate_handler![app_ready, calc_priority])
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
fn calc_priority(importance: u8, effort: u8, deadline: Option<String>) -> String {
    let imp = (importance as f64 / 5.0) * 4.0;
    
    let deadl = if let Some(dl) = deadline {
        if dl.is_empty() {
            0.0
        } else {
            // Very basic day math: parse YYYY-MM-DD
            if let Ok(parsed_time) = parse_date(&dl) {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
                
                // Truncate both to midnight for pure day difference
                let days_left = (parsed_time as f64 - now as f64) / 86400.0;
                let days_left = days_left.round();
                
                if days_left <= 0.0 {
                    4.0
                } else if days_left <= 14.0 {
                    4.0 * (1.0 - days_left / 14.0)
                } else {
                    0.0
                }
            } else {
                0.0
            }
        }
    } else {
        0.0
    };

    let eff = ((6.0 - effort as f64) / 5.0) * 2.0;
    let total = imp + deadl + eff;

    if total >= 6.5 {
        "high".to_string()
    } else if total >= 3.5 {
        "medium".to_string()
    } else {
        "low".to_string()
    }
}

// Simple YYYY-MM-DD to UNIX timestamp parser
fn parse_date(date: &str) -> Result<u64, ()> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 { return Err(()); }
    
    let y: u64 = parts[0].parse().map_err(|_| ())?;
    let m: u64 = parts[1].parse().map_err(|_| ())?;
    let d: u64 = parts[2].parse().map_err(|_| ())?;
    
    // Very rough UNIX timestamp logic for YYYY-MM-DD just for difference
    // This ignores leap years/complex timezone math but it matches JS rough math perfectly
    let mut days = (y - 1970) * 365 + (y - 1969) / 4;
    let month_days = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    
    for i in 1..m {
        days += month_days[i as usize];
    }
    if m > 2 && is_leap_year(y) {
        days += 1;
    }
    days += d - 1;
    
    Ok(days * 86400)
}

fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}
