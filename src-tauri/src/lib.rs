use tauri_plugin_sql::{Migration, MigrationKind};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, Emitter,
};
use chrono::{NaiveDate, Local};

mod integrations;
mod ai;
mod secrets;
mod backup;
mod planner;

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Work,
    Break,
}

struct PomoState {
    time_left: u32,
    is_active: bool,
    mode: Phase,
    phase_total: u32,
    work_secs: u32,
    short_break_secs: u32,
    long_break_secs: u32,
    auto_start_break: bool,
    completed_work: u32,
}

/// Payload emitted to the frontend on every `pomo-tick`.
#[derive(Clone, serde::Serialize)]
struct TickPayload {
    remaining: u32,
    total: u32,
    mode: String,
}

pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_schema",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "projects_recurrence_subtasks",
            sql: include_str!("../migrations/002_projects.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "milestones_custom_fields_templates",
            sql: include_str!("../migrations/003_milestones.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "soft_delete_trash",
            sql: include_str!("../migrations/004_trash.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "planner_schedule",
            sql: include_str!("../migrations/005_schedule.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "crdt_oplog",
            sql: include_str!("../migrations/006_oplog.sql"),
            kind: MigrationKind::Up,
        },
    ];

    let mut builder = tauri::Builder::default()
        .manage(std::sync::Mutex::new(PomoState {
            time_left: 25 * 60,
            is_active: false,
            mode: Phase::Work,
            phase_total: 25 * 60,
            work_secs: 25 * 60,
            short_break_secs: 5 * 60,
            long_break_secs: 15 * 60,
            auto_start_break: false,
            completed_work: 0,
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
        );

    // ── Auto-update + process control (desktop only) ──
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
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
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
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
            set_pomodoro_config,
            integrations::send_notification,
            integrations::start_oauth,
            integrations::oauth_token,
            integrations::oauth_api,
            integrations::fetch_ics,
            integrations::relay_fetch,
            ai::ai_generate,
            secrets::secret_get,
            secrets::secret_set,
            backup::backup_database,
            backup::list_backups,
            backup::restore_backup,
            backup::delete_backup,
            plan_day,
            plan_team
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

/// Plan a single day: deterministic, calendar- and energy-aware time-blocking.
/// Pure over its input; see `planner.rs`.
#[tauri::command]
fn plan_day(req: planner::PlanRequest) -> Result<planner::PlanResult, String> {
    Ok(planner::plan(&req))
}

/// Team auto-planning: balance work across members, then schedule each day.
/// Deterministic mirror of src/services/teamPlanService.ts. See `planner.rs`.
#[tauri::command]
fn plan_team(req: planner::TeamPlanRequest) -> Result<planner::TeamPlanResult, String> {
    Ok(planner::plan_team(&req))
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
                    let now = Local::now().naive_local().date();
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

/// Update the timer's durations and auto-break behaviour from Settings.
/// Durations arrive in minutes; the timer is the source of truth in seconds.
#[tauri::command]
fn set_pomodoro_config(
    state: tauri::State<'_, std::sync::Mutex<PomoState>>,
    work_mins: u32,
    short_break_mins: u32,
    long_break_mins: u32,
    auto_start_break: bool,
) -> Result<(), String> {
    let mut s = state.lock().unwrap();
    s.work_secs = work_mins.max(1) * 60;
    s.short_break_secs = short_break_mins.max(1) * 60;
    s.long_break_secs = long_break_mins.max(1) * 60;
    s.auto_start_break = auto_start_break;
    // Only re-prime the visible timer when idle, so we don't disrupt a run.
    if !s.is_active {
        s.mode = Phase::Work;
        s.time_left = s.work_secs;
        s.phase_total = s.work_secs;
    }
    Ok(())
}

#[tauri::command]
fn toggle_pomodoro(app: tauri::AppHandle, state: tauri::State<'_, std::sync::Mutex<PomoState>>) -> Result<bool, String> {
    let mut s = state.lock().unwrap();
    s.is_active = !s.is_active;
    let is_active = s.is_active;

    if is_active {
        // Start the background ticking loop.
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

                let mut finished_work = false;
                let (payload, still_active) = {
                    let state_mutex = app_clone.state::<std::sync::Mutex<PomoState>>();
                    let mut s_curr = state_mutex.lock().unwrap();
                    if !s_curr.is_active {
                        break;
                    }
                    if s_curr.time_left > 0 {
                        s_curr.time_left -= 1;
                    }

                    // Phase transition when the current phase hits zero.
                    if s_curr.time_left == 0 {
                        match s_curr.mode {
                            Phase::Work => {
                                s_curr.completed_work += 1;
                                finished_work = true;
                                if s_curr.auto_start_break {
                                    let long = s_curr.completed_work % 4 == 0;
                                    let blen = if long { s_curr.long_break_secs } else { s_curr.short_break_secs };
                                    s_curr.mode = Phase::Break;
                                    s_curr.phase_total = blen;
                                    s_curr.time_left = blen;
                                } else {
                                    // Stop and re-prime for the next work session.
                                    s_curr.is_active = false;
                                    s_curr.time_left = s_curr.work_secs;
                                    s_curr.phase_total = s_curr.work_secs;
                                }
                            }
                            Phase::Break => {
                                // Break over → back to a primed work session, stopped.
                                s_curr.mode = Phase::Work;
                                s_curr.is_active = false;
                                s_curr.time_left = s_curr.work_secs;
                                s_curr.phase_total = s_curr.work_secs;
                            }
                        }
                    }

                    let payload = TickPayload {
                        remaining: s_curr.time_left,
                        total: s_curr.phase_total.max(1),
                        mode: match s_curr.mode { Phase::Work => "work", Phase::Break => "break" }.to_string(),
                    };
                    (payload, s_curr.is_active)
                };

                let _ = app_clone.emit("pomo-tick", payload);
                if finished_work {
                    let _ = app_clone.emit("pomo-finished", ());
                }
                if !still_active {
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
    s.mode = Phase::Work;
    s.time_left = s.work_secs;
    s.phase_total = s.work_secs;
    Ok(())
}
