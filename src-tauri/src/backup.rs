//! Coherent SQLite online snapshots and transactional restore.
//! Never copy a live main file or remove its WAL/SHM sidecars.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};

pub(crate) static MAINTENANCE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Manager};

const DB_FILE: &str = "cognote.db";
const KEEP_RECENT: usize = 10;

#[derive(Serialize, Clone)]
pub struct BackupInfo {
    /// File name only (e.g. `cognote-20260624-143000-auto.db`).
    name: String,
    /// Absolute path on disk.
    path: String,
    /// Size in bytes.
    size: u64,
    /// Last-modified time, epoch milliseconds.
    created_ms: u64,
    /// Why the backup was taken (e.g. `auto`, `manual`, `pre-restore`).
    reason: String,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(DB_FILE))
}

fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?.join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create backups dir: {e}"))?;
    Ok(dir)
}

/// Sanitize a reason into a single filename-safe lowercase token. Non-alnum
/// chars are dropped so the trailing `-<reason>` token stays unambiguous (the
/// timestamp itself contains a `-`, and we parse the reason as the last token).
fn safe_reason(reason: &str) -> String {
    let r: String = reason.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if r.is_empty() { "manual".into() } else { r.to_lowercase() }
}

fn info_for(path: &Path) -> Option<BackupInfo> {
    let name = path.file_name()?.to_string_lossy().to_string();
    let meta = fs::metadata(path).ok()?;
    let created_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // Reason is the trailing token: cognote-<ts>-<reason>.db
    let reason = name
        .strip_prefix("cognote-")
        .and_then(|s| s.strip_suffix(".db"))
        .and_then(|s| s.rsplit('-').next())
        .unwrap_or("manual")
        .to_string();
    Some(BackupInfo {
        name,
        path: path.to_string_lossy().to_string(),
        size: meta.len(),
        created_ms,
        reason,
    })
}

/// All backups, newest first.
#[tauri::command]
pub fn list_backups(app: AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = backups_dir(&app)?;
    let mut out: Vec<BackupInfo> = fs::read_dir(&dir)
        .map_err(|e| format!("cannot read backups dir: {e}"))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "db").unwrap_or(false))
        .filter_map(|p| info_for(&p))
        .collect();
    // Newest first.
    out.sort_by_key(|b| std::cmp::Reverse(b.created_ms));
    Ok(out)
}

/// Delete every backup beyond the most recent `KEEP_RECENT`.
fn prune(app: &AppHandle) {
    if let Ok(list) = list_backups(app.clone()) {
        for old in list.into_iter().skip(KEEP_RECENT) {
            let _ = fs::remove_file(&old.path);
        }
    }
}

async fn open(path: &Path, writable: bool, create: bool) -> Result<SqliteConnection, String> {
    SqliteConnection::connect_with(
        &SqliteConnectOptions::new().filename(path).read_only(!writable)
            .create_if_missing(create).busy_timeout(Duration::from_secs(5))
    ).await.map_err(|e| format!("cannot open database: {e}"))
}

async fn validate(connection: &mut SqliteConnection) -> Result<(), String> {
    let rows: Vec<String> = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_all(&mut *connection).await.map_err(|e| format!("integrity check failed: {e}"))?;
    if rows != ["ok"] { return Err(format!("database integrity failed: {}", rows.join("; "))); }
    // Reject empty SQLite files and unrelated databases before touching live data.
    for table in ["tasks", "app_state", "projects", "milestones", "templates", "calendar_events", "oplog"] {
        let exists: i64 = sqlx::query_scalar("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?")
            .bind(table).fetch_one(&mut *connection).await.map_err(|e| e.to_string())?;
        if exists != 1 { return Err(format!("incompatible snapshot: missing {table}")); }
    }
    sqlx::query("SELECT id, deleted_at, scheduled_start, scheduled_end, custom_fields FROM tasks LIMIT 0")
        .execute(&mut *connection).await.map_err(|e| format!("incompatible task schema: {e}"))?;
    Ok(())
}

/// Copy through SQLite's own write transaction. Both SQLx worker handles are
/// locked for the FFI calls. An unfinished/failed backup rolls back on finish.
async fn online_copy(source: &mut SqliteConnection, destination: &mut SqliteConnection) -> Result<(), String> {
    let mut src = source.lock_handle().await.map_err(|e| e.to_string())?;
    let mut dst = destination.lock_handle().await.map_err(|e| e.to_string())?;
    // SAFETY: SQLx guards exclusively own two distinct live handles throughout
    // init/step/finish; the backup is always finished before either guard drops.
    unsafe {
        let backup = libsqlite3_sys::sqlite3_backup_init(
            dst.as_raw_handle().as_ptr(), c"main".as_ptr(),
            src.as_raw_handle().as_ptr(), c"main".as_ptr(),
        );
        if backup.is_null() { return Err("SQLite could not start snapshot transaction".into()); }
        let step = libsqlite3_sys::sqlite3_backup_step(backup, -1);
        let finish = libsqlite3_sys::sqlite3_backup_finish(backup);
        if step != libsqlite3_sys::SQLITE_DONE || finish != libsqlite3_sys::SQLITE_OK {
            return Err(format!("SQLite snapshot transaction failed (step={step}, finish={finish}); destination rolled back"));
        }
    }
    Ok(())
}

async fn snapshot(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() { return Err("snapshot destination already exists".into()); }
    let mut src = open(source, false, false).await?;
    validate(&mut src).await?;
    let temporary = destination.with_extension("pending");
    fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
        .map_err(|e| format!("cannot reserve snapshot: {e}"))?;
    let mut dst = open(&temporary, true, false).await?;
    // A standalone DELETE-mode file needs no WAL sidecar to restore elsewhere.
    sqlx::query("PRAGMA journal_mode=DELETE").execute(&mut dst).await.map_err(|e| e.to_string())?;
    let result = async {
        online_copy(&mut src, &mut dst).await?;
        validate(&mut dst).await
    }.await;
    dst.close().await.map_err(|e| e.to_string())?;
    src.close().await.map_err(|e| e.to_string())?;
    result?;
    fs::File::open(&temporary).and_then(|file| file.sync_all()).map_err(|e| format!("snapshot sync failed: {e}"))?;
    fs::rename(&temporary, destination).map_err(|e| format!("cannot publish snapshot: {e}"))?;
    #[cfg(unix)]
    fs::File::open(destination.parent().ok_or("snapshot directory unavailable")?)
        .and_then(|file| file.sync_all()).map_err(|e| format!("snapshot directory sync failed: {e}"))?;
    Ok(())
}

async fn create_snapshot(app: &AppHandle, reason: &str) -> Result<BackupInfo, String> {
    let dir = backups_dir(app)?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%f");
    let name = format!("cognote-{stamp}-{}.db", safe_reason(reason));
    let dest = dir.join(name);
    // Incomplete snapshots never appear in the backup list.
    snapshot(&db_path(app)?, &dest).await?;
    info_for(&dest).ok_or_else(|| "snapshot metadata unavailable".into())
}

#[tauri::command]
pub async fn backup_database(app: AppHandle, reason: Option<String>) -> Result<BackupInfo, String> {
    let _guard = MAINTENANCE.lock().await;
    let info = create_snapshot(&app, reason.as_deref().unwrap_or("manual")).await?;
    prune(&app);
    Ok(info)
}

fn checked_name(name: &str) -> Result<(), String> {
    if !name.starts_with("cognote-") || !name.ends_with(".db") || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid backup name".into());
    }
    Ok(())
}

async fn restore_snapshot(backup: &Path, live: &Path, safety: &Path) -> Result<(), String> {
    let mut src = open(backup, false, false).await?;
    validate(&mut src).await?;
    // Any failure here aborts restore; never discard the last surviving state.
    snapshot(live, safety).await?;
    let mut dst = open(live, true, false).await?;
    online_copy(&mut src, &mut dst).await?;
    validate(&mut dst).await?;
    dst.close().await.map_err(|e| e.to_string())?;
    src.close().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Restore into the live SQLite database transactionally, retaining its WAL
/// lifecycle. The frontend drains and closes the plugin pool first, then reloads.
#[tauri::command]
pub async fn restore_backup(app: AppHandle, name: String) -> Result<(), String> {
    let _guard = MAINTENANCE.lock().await;
    checked_name(&name)?;
    let backup = backups_dir(&app)?.join(&name);
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S-%f");
    let safety = backups_dir(&app)?.join(format!("cognote-{stamp}-prerestore.db"));
    restore_snapshot(&backup, &db_path(&app)?, &safety).await?;
    // Keep the selected backup and safety snapshot until recovery is confirmed.
    Ok(())
}

/// Permanently delete a single backup file.
#[tauri::command]
pub fn delete_backup(app: AppHandle, name: String) -> Result<(), String> {
    checked_name(&name)?;
    let path = backups_dir(&app)?.join(&name);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete failed: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("cognate-backup-{}-{nonce}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> PathBuf { self.0.join(name) }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    async fn database(path: &Path) -> SqliteConnection {
        let mut db = open(path, true, true).await.unwrap();
        for migration in [
            include_str!("../migrations/001_init.sql"), include_str!("../migrations/002_projects.sql"),
            include_str!("../migrations/003_milestones.sql"), include_str!("../migrations/004_trash.sql"),
            include_str!("../migrations/005_schedule.sql"), include_str!("../migrations/006_oplog.sql"),
        ] { sqlx::raw_sql(migration).execute(&mut db).await.unwrap(); }
        sqlx::raw_sql("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
            INSERT INTO tasks(id,title,created_at) VALUES ('task','before','2026-10-06');
            INSERT INTO oplog(id,wall,counter,actor,kind,entity,field,value) VALUES ('op',1,0,'device','set','task','title','\"before\"');
            INSERT INTO projects(id,name,created_at) VALUES ('project','Example','2026-10-06');
            INSERT INTO app_state(key,value) VALUES ('seeded','1');")
            .execute(&mut db).await.unwrap();
        db
    }
    async fn title(db: &mut SqliteConnection) -> String {
        sqlx::query_scalar("SELECT title FROM tasks WHERE id='task'").fetch_one(db).await.unwrap()
    }

    #[tokio::test]
    async fn snapshot_captures_uncheckpointed_wal_and_restore_keeps_open_readers_coherent() {
        let f = Fixture::new();
        let live = f.path("live.db");
        let mut writer = database(&live).await;
        assert!(fs::metadata(f.path("live.db-wal")).unwrap().len() > 0);
        let backup = f.path("backup.db");
        snapshot(&live, &backup).await.unwrap();
        let mut saved = open(&backup, false, false).await.unwrap();
        assert_eq!(title(&mut saved).await, "before");
        let ops: i64 = sqlx::query_scalar("SELECT count(*) FROM oplog").fetch_one(&mut saved).await.unwrap();
        assert_eq!(ops, 1);
        saved.close().await.unwrap();
        sqlx::query("UPDATE tasks SET title='after'").execute(&mut writer).await.unwrap();
        // Prime a cached statement on another already-open native connection.
        let mut reader = open(&live, true, false).await.unwrap();
        assert_eq!(title(&mut reader).await, "after");
        restore_snapshot(&backup, &live, &f.path("safety.db")).await.unwrap();
        assert_eq!(title(&mut reader).await, "before");
        assert_eq!(title(&mut writer).await, "before");
        let mut safety = open(&f.path("safety.db"), false, false).await.unwrap();
        assert_eq!(title(&mut safety).await, "after");
        validate(&mut writer).await.unwrap();
        safety.close().await.unwrap(); reader.close().await.unwrap(); writer.close().await.unwrap();
    }

    #[tokio::test]
    async fn corrupt_or_foreign_snapshot_never_changes_live_data() {
        let f = Fixture::new();
        let live = f.path("live.db");
        let mut db = database(&live).await;
        let corrupt = f.path("corrupt.db");
        fs::write(&corrupt, "not a database").unwrap();
        assert!(restore_snapshot(&corrupt, &live, &f.path("safety.db")).await.is_err());
        let foreign = f.path("foreign.db");
        let other = open(&foreign, true, true).await.unwrap();
        other.close().await.unwrap();
        assert!(restore_snapshot(&foreign, &live, &f.path("safety.db")).await.is_err());
        assert_eq!(title(&mut db).await, "before");
        assert!(!f.path("safety.db").exists());
        db.close().await.unwrap();
    }

    #[tokio::test]
    async fn required_safety_snapshot_failure_aborts_restore() {
        let f = Fixture::new();
        let live = f.path("live.db");
        let mut db = database(&live).await;
        let backup = f.path("backup.db");
        snapshot(&live, &backup).await.unwrap();
        sqlx::query("UPDATE tasks SET title='keep me'").execute(&mut db).await.unwrap();
        fs::write(f.path("occupied.db"), "existing snapshot").unwrap();
        assert!(restore_snapshot(&backup, &live, &f.path("occupied.db")).await.is_err());
        assert_eq!(title(&mut db).await, "keep me");
        db.close().await.unwrap();
    }

    #[tokio::test]
    async fn failed_backup_transaction_rolls_back_destination() {
        let f = Fixture::new();
        let mut src = database(&f.path("source.db")).await;
        let mut dst = database(&f.path("destination.db")).await;
        sqlx::query("UPDATE tasks SET title='destination'").execute(&mut dst).await.unwrap();
        sqlx::query("BEGIN IMMEDIATE").execute(&mut dst).await.unwrap();
        assert!(online_copy(&mut src, &mut dst).await.is_err());
        sqlx::query("ROLLBACK").execute(&mut dst).await.unwrap();
        assert_eq!(title(&mut dst).await, "destination");
        validate(&mut dst).await.unwrap();
        src.close().await.unwrap(); dst.close().await.unwrap();
    }

    #[test]
    fn backup_names_reject_traversal_and_unrelated_files() {
        for name in ["../cognote-x.db", "cognote-../x.db", "cognote-\\x.db", "other.db", "cognote-x.pending"] {
            assert!(checked_name(name).is_err());
        }
        assert!(checked_name("cognote-20261006-123456-manual.db").is_ok());
    }
}
