//! Desktop reminders that continue while the main window is hidden.
//! The frontend's deadline watcher is browser-only; desktop reads the same
//! SQLite database as the UI and records delivered alerts in app_state.

use std::time::Duration;

use chrono::{DateTime, Local, NaiveDateTime};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

const DATABASE_FILE: &str = "cognote.db";
// The scanner wakes every minute. A short grace period tolerates scheduling
// jitter without alerting for a plan that is already far in the past.
const BLOCK_START_GRACE_SECONDS: i64 = 3 * 60;

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Give the frontend time to initialize the SQL plugin and run migrations.
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            if let Err(error) = check_reminders(&app).await {
                log::warn!("background reminder check failed: {error}");
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

async fn check_reminders(app: &AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?
        .join(DATABASE_FILE);
    if !path.is_file() {
        return Ok(());
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .read_only(false)
        .create_if_missing(false)
        .busy_timeout(Duration::from_secs(5));
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| error.to_string())?;
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    // Start alerts are time-sensitive, so process them before a possible
    // backlog of due and overdue tasks.
    scan_block_starts(&mut connection, now.naive_local(), |title, body| {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    })
    .await?;
    scan_due(&mut connection, &today, |title, body| {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    })
    .await?;
    Ok(())
}

async fn notifications_enabled(connection: &mut SqliteConnection) -> Result<bool, String> {
    let enabled: Option<String> =
        sqlx::query_scalar("SELECT value FROM app_state WHERE key = 'notify_enabled'")
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| error.to_string())?;
    Ok(enabled.as_deref().map(|value| value == "1").unwrap_or(true))
}

fn local_block_start(value: &str) -> Option<NaiveDateTime> {
    // The planner stores local wall time without an offset. Accept RFC 3339
    // too, for imported or future schedules that include an explicit offset.
    if let Ok(instant) = DateTime::parse_from_rfc3339(value) {
        return Some(instant.with_timezone(&Local).naive_local());
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M"))
        .ok()
}

async fn scan_block_starts(
    connection: &mut SqliteConnection,
    now: NaiveDateTime,
    mut deliver: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<usize, String> {
    if !notifications_enabled(connection).await? {
        return Ok(0);
    }

    let blocks: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, scheduled_start FROM tasks \
         WHERE done = 0 AND deleted_at IS NULL \
         AND scheduled_start IS NOT NULL AND scheduled_start <> ''",
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;

    let mut sent = 0;
    for (id, title, scheduled_start) in blocks {
        let Some(start) = local_block_start(&scheduled_start) else {
            log::warn!("skipping invalid scheduled_start for task {id}");
            continue;
        };
        let elapsed = now.signed_duration_since(start).num_seconds();
        if !(0..BLOCK_START_GRACE_SECONDS).contains(&elapsed) {
            continue;
        }

        // The scheduled start is part of the key: moving a block to a new
        // time makes the new start eligible, without repeating the old alert.
        let key = format!("desktop_block_start:{id}:{scheduled_start}");
        let already_sent: Option<i64> = sqlx::query_scalar("SELECT 1 FROM app_state WHERE key = ?")
            .bind(&key)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| error.to_string())?;
        if already_sent.is_some() {
            continue;
        }

        deliver(
            "Time to start a task",
            &format!("Your planned block for {title} starts now"),
        )?;
        sqlx::query("INSERT OR IGNORE INTO app_state (key, value) VALUES (?, '1')")
            .bind(&key)
            .execute(&mut *connection)
            .await
            .map_err(|error| error.to_string())?;
        sent += 1;
    }
    Ok(sent)
}

async fn scan_due(
    connection: &mut SqliteConnection,
    today: &str,
    mut deliver: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<usize, String> {
    if !notifications_enabled(connection).await? {
        return Ok(0);
    }

    let tasks: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, title, deadline FROM tasks \
         WHERE done = 0 AND deleted_at IS NULL AND deadline <> '' AND deadline <= ? \
         ORDER BY deadline, id",
    )
    .bind(today)
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| error.to_string())?;

    let mut sent = 0;
    for (id, title, deadline) in tasks {
        let key = format!("desktop_deadline:{today}:{id}");
        let already_sent: Option<i64> = sqlx::query_scalar("SELECT 1 FROM app_state WHERE key = ?")
            .bind(&key)
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| error.to_string())?;
        if already_sent.is_some() {
            continue;
        }

        let overdue = deadline.as_str() < today;
        let heading = if overdue {
            "Task overdue"
        } else {
            "Task due today"
        };
        let body = if overdue {
            format!("{title} — was due {deadline}")
        } else {
            title
        };
        // Record only successful delivery, so a transient OS notification
        // failure can be retried on the next scan.
        deliver(heading, &body)?;
        sqlx::query("INSERT OR IGNORE INTO app_state (key, value) VALUES (?, '1')")
            .bind(&key)
            .execute(&mut *connection)
            .await
            .map_err(|error| error.to_string())?;
        sent += 1;
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn database() -> SqliteConnection {
        let mut connection = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, deadline TEXT NOT NULL, \
             done INTEGER NOT NULL, deleted_at TEXT, scheduled_start TEXT)",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        connection
    }

    #[tokio::test]
    async fn sends_due_tasks_once_per_local_day_and_skips_completed_or_deleted() {
        let mut connection = database().await;
        for (id, deadline, done, deleted) in [
            ("today", "2026-09-28", 0, None),
            ("overdue", "2026-09-27", 0, None),
            ("future", "2026-09-29", 0, None),
            ("done", "2026-09-28", 1, None),
            ("trash", "2026-09-28", 0, Some("2026-09-28")),
        ] {
            sqlx::query(
                "INSERT INTO tasks (id, title, deadline, done, deleted_at) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(id)
            .bind(deadline)
            .bind(done)
            .bind(deleted)
            .execute(&mut connection)
            .await
            .unwrap();
        }
        let mut messages = Vec::new();
        let sent = scan_due(&mut connection, "2026-09-28", |title, body| {
            messages.push((title.to_owned(), body.to_owned()));
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(sent, 2);
        assert!(messages.iter().any(|(title, _)| title == "Task overdue"));
        assert_eq!(
            scan_due(&mut connection, "2026-09-28", |_, _| Ok(()))
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            scan_due(&mut connection, "2026-09-29", |_, _| Ok(()))
                .await
                .unwrap(),
            3
        );
    }

    #[tokio::test]
    async fn disabled_notifications_and_delivery_failures_do_not_mark_tasks_sent() {
        let mut connection = database().await;
        sqlx::query("INSERT INTO tasks (id, title, deadline, done, deleted_at) VALUES ('one', 'One', '2026-09-28', 0, NULL)")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("INSERT INTO app_state VALUES ('notify_enabled', '0')")
            .execute(&mut connection)
            .await
            .unwrap();
        assert_eq!(
            scan_due(&mut connection, "2026-09-28", |_, _| Ok(()))
                .await
                .unwrap(),
            0
        );
        sqlx::query("UPDATE app_state SET value = '1' WHERE key = 'notify_enabled'")
            .execute(&mut connection)
            .await
            .unwrap();
        assert!(scan_due(&mut connection, "2026-09-28", |_, _| Err(
            "OS unavailable".into()
        ))
        .await
        .is_err());
        assert_eq!(
            scan_due(&mut connection, "2026-09-28", |_, _| Ok(()))
                .await
                .unwrap(),
            1
        );
    }

    fn time(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").unwrap()
    }

    #[tokio::test]
    async fn scheduled_block_alerts_at_start_once_and_uses_latest_time() {
        let mut connection = database().await;
        sqlx::query(
            "INSERT INTO tasks (id, title, deadline, done, deleted_at, scheduled_start) \
             VALUES ('one', 'Write report', '', 0, NULL, '2026-09-28T14:00:00')",
        )
        .execute(&mut connection)
        .await
        .unwrap();
        let mut messages = Vec::new();
        assert_eq!(
            scan_block_starts(&mut connection, time("2026-09-28T13:59:59"), |_, _| Ok(()))
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            scan_block_starts(
                &mut connection,
                time("2026-09-28T14:01:00"),
                |title, body| {
                    messages.push((title.to_owned(), body.to_owned()));
                    Ok(())
                }
            )
            .await
            .unwrap(),
            1
        );
        assert_eq!(messages[0].0, "Time to start a task");
        assert!(messages[0].1.contains("Write report"));
        assert_eq!(
            scan_block_starts(&mut connection, time("2026-09-28T14:02:00"), |_, _| Ok(()))
                .await
                .unwrap(),
            0
        );

        sqlx::query("UPDATE tasks SET scheduled_start = '2026-09-28T14:05:00' WHERE id = 'one'")
            .execute(&mut connection)
            .await
            .unwrap();
        assert_eq!(
            scan_block_starts(&mut connection, time("2026-09-28T14:05:00"), |_, _| Ok(()))
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            scan_block_starts(&mut connection, time("2026-09-28T14:10:00"), |_, _| Ok(()))
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn block_alerts_respect_settings_completion_and_retry_failed_delivery() {
        let mut connection = database().await;
        for (id, done, deleted) in [
            ("open", 0, None),
            ("done", 1, None),
            ("trash", 0, Some("2026-09-28")),
        ] {
            sqlx::query("INSERT INTO tasks VALUES (?, ?, '', ?, ?, '2026-09-28T14:00:00')")
                .bind(id)
                .bind(id)
                .bind(done)
                .bind(deleted)
                .execute(&mut connection)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO app_state VALUES ('notify_enabled', '0')")
            .execute(&mut connection)
            .await
            .unwrap();
        let now = time("2026-09-28T14:00:30");
        assert_eq!(
            scan_block_starts(&mut connection, now, |_, _| Ok(()))
                .await
                .unwrap(),
            0
        );
        sqlx::query("UPDATE app_state SET value = '1' WHERE key = 'notify_enabled'")
            .execute(&mut connection)
            .await
            .unwrap();
        assert!(
            scan_block_starts(&mut connection, now, |_, _| Err("OS unavailable".into()))
                .await
                .is_err()
        );
        assert_eq!(
            scan_block_starts(&mut connection, now, |_, _| Ok(()))
                .await
                .unwrap(),
            1
        );
    }
}
