//! iCloud snapshot publisher (Phase ②b, both flavors).
//!
//! Runs as a SIBLING task to the sidecar supervisor (see lib.rs setup) — NOT
//! inside `spawn_and_supervise`, whose shutdown/respawn/crash-breaker invariants
//! are delicate. On a fixed cadence it:
//!   1. resolves the iCloud container (on a blocking thread — landmine #36),
//!   2. fetches the assembled snapshot from the sidecar over loopback,
//!   3. stamps `seq` (monotonic, parent-owned) + `writerId`, and
//!   4. performs the coordinated atomic write (also on a blocking thread).
//!
//! The PARENT owns the write + the freshness metadata, which makes it the
//! single authoritative writer and structurally avoids the two-writer race a
//! sidecar-owned write would hit during sidecar respawn.
//!
//! The loop exits cleanly on quit by racing `AppState::shutdown` (the same
//! `Notify` the supervisor uses) and checking the `shutting_down` flag.
//!
//! BOTH flavors run this loop: MAS resolves the iCloud container via the
//! sandbox-correct ubiquity API, the DMG via the direct unsandboxed path
//! (`icloud_writer::resolve_icloud_container`, cfg-branched by flavor).

#![cfg(target_os = "macos")]

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::Manager;
use tauri_plugin_store::StoreExt;

/// How often to republish the snapshot. 5 min balances freshness on the phone
/// against iCloud upload churn (each write triggers a sync).
const PUBLISH_INTERVAL_SECS: u64 = 300;
/// Delay before the FIRST publish so the sidecar has bound its port (cold start
/// is typically a few seconds). If it's still not ready, the tick is skipped and
/// retried next interval.
const FIRST_PUBLISH_DELAY_SECS: u64 = 20;
/// Tauri-store keys (in the parent's own settings.json — sandbox-local under MAS).
const SEQ_KEY: &str = "icloud_snapshot_seq";
const WRITER_ID_KEY: &str = "icloud_writer_id";
/// v1.2.0 Item 4: persisted sync-health state, read cheaply by get_sync_health.
const LAST_PUBLISHED_AT_KEY: &str = "icloud_last_published_at";
const LAST_UPLOAD_OK_KEY: &str = "icloud_last_upload_ok";
const LAST_UPLOAD_ERROR_KEY: &str = "icloud_last_upload_error_present";

/// Drive the publish loop until the app shuts down.
pub async fn run(app: tauri::AppHandle) {
    // Extract the shared shutdown plumbing + port slot, then drop the State
    // borrow so nothing non-'static is held across the loop's awaits.
    let (shutdown, shutting_down, server_port) = {
        let Some(state) = app.try_state::<crate::ipc::AppState>() else {
            log::warn!("iCloud publish: AppState unavailable; publisher not started");
            return;
        };
        (
            state.shutdown.clone(),
            state.shutting_down.clone(),
            state.server_port.clone(),
        )
    };

    let start = tokio::time::Instant::now() + Duration::from_secs(FIRST_PUBLISH_DELAY_SECS);
    let mut interval = tokio::time::interval_at(start, Duration::from_secs(PUBLISH_INTERVAL_SECS));

    loop {
        tokio::select! {
            _ = interval.tick() => {}
            _ = shutdown.notified() => break,
        }
        // Level-triggered guard: catches a shutdown signaled before we reached
        // `notified()` (signal_shutdown uses notify_waiters, which is lost on a
        // not-yet-awaiting observer).
        if shutting_down.load(Ordering::SeqCst) {
            break;
        }
        match publish_once(&app, &server_port).await {
            Ok(seq) => log::info!("iCloud snapshot published (seq {seq})"),
            Err(PublishError::Skip(e)) => log::debug!("iCloud publish skipped this tick: {e}"),
            Err(PublishError::Failure(e)) => log::warn!("iCloud publish FAILED this tick: {e}"),
        }
    }
    log::info!("iCloud publish loop exited");
}

/// Why a publish tick produced no snapshot.
enum PublishError {
    /// Expected idle states (not signed into iCloud, sidecar not up yet) —
    /// logged at debug to keep non-iCloud users' logs quiet.
    Skip(String),
    /// Preconditions held but the publish itself failed — logged at warn
    /// (v1.2.0: these were debug, which hid hard failures entirely).
    Failure(String),
}

/// One publish attempt. Returns the published `seq` on success, or an `Err`
/// describing why the tick was skipped (Skip = expected idle states, logged
/// debug; Failure = real breakage, logged warn — v1.2.0).
async fn publish_once(
    app: &tauri::AppHandle,
    server_port: &Arc<Mutex<Option<u16>>>,
) -> Result<u64, PublishError> {
    // Gate: is the iCloud container resolvable right now? Resolve on a blocking
    // thread (landmine #36). `None` cleanly covers "not signed in" / "no
    // entitlement" — skip the tick quietly rather than erroring loudly.
    let available = tauri::async_runtime::spawn_blocking(|| {
        crate::icloud_writer::resolve_icloud_container().is_some()
    })
    .await
    .map_err(|e| PublishError::Failure(format!("resolve join failed: {e}")))?;
    if !available {
        return Err(PublishError::Skip(
            "iCloud container not resolvable (not signed in or no entitlement)".to_string(),
        ));
    }

    // v1.2.0 Item 4: read the PREVIOUS cycle's upload status (the file the last
    // tick wrote) BEFORE this tick's write — IsUploaded reads false right after
    // a fresh write, so we read the older file's settled state. Same thread as
    // the future write (landmine #35); cheap enough to do per tick.
    let (upload_ok, upload_error) =
        tauri::async_runtime::spawn_blocking(
            || match crate::icloud_writer::resolve_icloud_container() {
                Some(container) => crate::icloud_writer::read_upload_status(&container),
                None => (false, false),
            },
        )
        .await
        .map_err(|e| PublishError::Failure(format!("upload-status join failed: {e}")))?;
    persist_upload_status(app, upload_ok, upload_error);

    // Read the sidecar port (None until the sidecar binds it).
    let port = {
        let guard = server_port
            .lock()
            .map_err(|e| PublishError::Failure(format!("port lock poisoned: {e}")))?;
        (*guard).ok_or_else(|| PublishError::Skip("sidecar port not yet set".to_string()))?
    };

    // Fetch the assembled snapshot over loopback. Shared 5s-timeout client
    // (v1.2.0): this await sits OUTSIDE the loop's shutdown select!, so a
    // hung response used to wedge publishing AND shutdown observation.
    let url = format!("http://127.0.0.1:{port}/api/snapshot");
    let resp = crate::http_client::LOCAL_CLIENT
        .get(&url)
        .send()
        .await
        .map_err(|e| PublishError::Failure(format!("snapshot fetch: {e}")))?;
    if !resp.status().is_success() {
        return Err(PublishError::Failure(format!(
            "HTTP {} from /api/snapshot",
            resp.status()
        )));
    }
    let mut snapshot: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| PublishError::Failure(format!("snapshot body: {e}")))?;

    // Parent stamps freshness metadata (single authoritative writer).
    let seq = next_seq_value(read_current_seq(app));
    let writer = writer_id(app).map_err(PublishError::Failure)?;
    stamp(&mut snapshot, seq, &writer);
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| PublishError::Failure(e.to_string()))?;

    // Resolve + coordinated write on ONE blocking thread so the Retained<NSURL>
    // never crosses threads (landmine #36).
    tauri::async_runtime::spawn_blocking(move || {
        match crate::icloud_writer::resolve_icloud_container() {
            Some(container) => crate::icloud_writer::write_snapshot_coordinated(&container, &bytes),
            None => Err("iCloud container vanished before write".to_string()),
        }
    })
    .await
    .map_err(|e| PublishError::Failure(format!("write join failed: {e}")))?
    .map_err(PublishError::Failure)?;

    // Persist `seq` only AFTER a successful write, so a failed write doesn't burn
    // a sequence number. (Gaps would be harmless, but this keeps seq == latest
    // successfully published version.)
    persist_seq(app, seq);
    Ok(seq)
}

/// Read the last persisted sequence number (None if absent or store unreadable).
fn read_current_seq(app: &tauri::AppHandle) -> Option<u64> {
    let store = app.store("settings.json").ok()?;
    store.get(SEQ_KEY).and_then(|v| v.as_u64())
}

/// Pure: the next sequence number given the current persisted one.
fn next_seq_value(current: Option<u64>) -> u64 {
    current.unwrap_or(0).saturating_add(1)
}

/// Persist the sequence number (best-effort; a failure only loses monotonicity
/// across a restart, which `generatedAt` still disambiguates for the reader).
fn persist_seq(app: &tauri::AppHandle, seq: u64) {
    if let Ok(store) = app.store("settings.json") {
        store.set(SEQ_KEY, serde_json::json!(seq));
        if let Err(e) = store.save() {
            log::warn!("iCloud publish: failed to persist seq {seq}: {e}");
        }
    }
}

/// Persist the previous-cycle upload status + a publish timestamp so the cheap
/// `get_sync_health` IPC can derive state without touching the container.
/// Best-effort: a failure only delays the next health read by one tick.
fn persist_upload_status(app: &tauri::AppHandle, upload_ok: bool, upload_error: bool) {
    if let Ok(store) = app.store("settings.json") {
        let now = chrono::Utc::now().timestamp();
        store.set(LAST_PUBLISHED_AT_KEY, serde_json::json!(now));
        store.set(LAST_UPLOAD_OK_KEY, serde_json::json!(upload_ok));
        store.set(LAST_UPLOAD_ERROR_KEY, serde_json::json!(upload_error));
        if let Err(e) = store.save() {
            log::warn!("iCloud publish: failed to persist upload status: {e}");
        }
    }
}

/// Get the per-install writer id, minting + persisting it once. Not
/// security-sensitive — just a tag so a future multi-writer reader could
/// attribute a snapshot; time-based is unique enough for one writer per install.
fn writer_id(app: &tauri::AppHandle) -> Result<String, String> {
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    if let Some(id) = store
        .get(WRITER_ID_KEY)
        .and_then(|v| v.as_str().map(str::to_owned))
    {
        return Ok(id);
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let id = format!("mac-{nanos}");
    store.set(WRITER_ID_KEY, serde_json::json!(id.clone()));
    store.save().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Pure: stamp freshness metadata onto an assembled snapshot. No-op on a
/// non-object value (defensive; the sidecar always returns an object).
fn stamp(snapshot: &mut serde_json::Value, seq: u64, writer_id: &str) {
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("seq".to_string(), serde_json::json!(seq));
        obj.insert("writerId".to_string(), serde_json::json!(writer_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_seq_starts_at_one_when_unset() {
        assert_eq!(next_seq_value(None), 1);
    }

    #[test]
    fn next_seq_strictly_increases_each_publish() {
        assert_eq!(next_seq_value(Some(0)), 1);
        assert_eq!(next_seq_value(Some(41)), 42);
        let a = next_seq_value(Some(7));
        let b = next_seq_value(Some(a));
        assert!(b > a, "seq must strictly increase across publishes");
    }

    #[test]
    fn stamp_inserts_seq_and_writer_id_preserving_other_fields() {
        let mut snap = serde_json::json!({ "schemaVersion": 1, "summary": { "cost": 1.5 } });
        stamp(&mut snap, 5, "mac-123");
        assert_eq!(snap["seq"], serde_json::json!(5));
        assert_eq!(snap["writerId"], serde_json::json!("mac-123"));
        assert_eq!(snap["schemaVersion"], serde_json::json!(1));
        assert_eq!(snap["summary"]["cost"], serde_json::json!(1.5));
    }

    #[test]
    fn stamp_is_noop_on_non_object() {
        let mut snap = serde_json::json!("not an object");
        stamp(&mut snap, 1, "x");
        assert_eq!(snap, serde_json::json!("not an object"));
    }
}
