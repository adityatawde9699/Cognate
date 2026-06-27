//! Data-safety: timestamped SQLite backups + one-click restore.
//!
//! The live database lives at `app_config_dir()/cognote.db` (the path
//! tauri-plugin-sql derives from the `sqlite:cognote.db` connection string).
//! Backups are plain file copies kept in `app_config_dir()/backups/`.
//!
//! Consistency: the frontend issues `PRAGMA wal_checkpoint(TRUNCATE)` before
//! asking us to copy, which folds the write-ahead log back into the main file
//! and empties it — so a copy of the single main file is a coherent snapshot.
//! On restore we drop any stale `-wal`/`-shm` sidecars so they can't clobber
//! the file we just put back.

use std::fs;
use std::path::PathBuf;
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

fn info_for(path: &PathBuf) -> Option<BackupInfo> {
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

/// Copy the live database into `backups/` with a timestamped name.
/// The frontend must checkpoint the WAL first for a consistent snapshot.
#[tauri::command]
pub fn backup_database(app: AppHandle, reason: Option<String>) -> Result<BackupInfo, String> {
    let src = db_path(&app)?;
    if !src.exists() {
        return Err("no database file to back up yet".into());
    }
    let reason = safe_reason(reason.as_deref().unwrap_or("manual"));
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let name = format!("cognote-{stamp}-{reason}.db");
    let dest = backups_dir(&app)?.join(&name);

    fs::copy(&src, &dest).map_err(|e| format!("backup copy failed: {e}"))?;
    prune(&app);

    info_for(&dest).ok_or_else(|| "backup created but could not be read back".into())
}

/// Restore a backup over the live database. Snapshots the current DB first
/// (reason `pre-restore`) so the restore itself is reversible, then swaps the
/// file in and clears stale WAL sidecars. The frontend must reload afterward
/// so the SQL plugin reopens the new file.
#[tauri::command]
pub fn restore_backup(app: AppHandle, name: String) -> Result<(), String> {
    // Disallow path traversal — operate strictly inside backups/.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid backup name".into());
    }
    let backup = backups_dir(&app)?.join(&name);
    if !backup.exists() {
        return Err(format!("backup not found: {name}"));
    }
    let live = db_path(&app)?;

    // Safety net: snapshot current state before overwriting it.
    if live.exists() {
        let _ = backup_database(app.clone(), Some("prerestore".into()));
    }

    fs::copy(&backup, &live).map_err(|e| format!("restore copy failed: {e}"))?;

    // Remove stale write-ahead-log sidecars so they don't override the restore.
    for ext in ["cognote.db-wal", "cognote.db-shm"] {
        let p = config_dir(&app)?.join(ext);
        if p.exists() {
            let _ = fs::remove_file(p);
        }
    }
    Ok(())
}

/// Permanently delete a single backup file.
#[tauri::command]
pub fn delete_backup(app: AppHandle, name: String) -> Result<(), String> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid backup name".into());
    }
    let path = backups_dir(&app)?.join(&name);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete failed: {e}"))?;
    }
    Ok(())
}
