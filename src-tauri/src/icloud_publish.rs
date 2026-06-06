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
            Err(e) => log::debug!("iCloud publish skipped this tick: {e}"),
        }
    }
    log::info!("iCloud publish loop exited");
}

/// One publish attempt. Returns the published `seq` on success, or an `Err`
/// describing why the tick was skipped (logged at debug — these are expected
/// when the user isn't signed into iCloud or the sidecar isn't up yet).
async fn publish_once(
    app: &tauri::AppHandle,
    server_port: &Arc<Mutex<Option<u16>>>,
) -> Result<u64, String> {
    // Gate: is the iCloud container resolvable right now? Resolve on a blocking
    // thread (landmine #36). `None` cleanly covers "not signed in" / "no
    // entitlement" — skip the tick quietly rather than erroring loudly.
    let available = tauri::async_runtime::spawn_blocking(|| {
        crate::icloud_writer::resolve_icloud_container().is_some()
    })
    .await
    .map_err(|e| format!("resolve join failed: {e}"))?;
    if !available {
        return Err(
            "iCloud container not resolvable (not signed in or no entitlement)".to_string(),
        );
    }

    // Read the sidecar port (None until the sidecar binds it).
    let port = {
        let guard = server_port
            .lock()
            .map_err(|e| format!("port lock poisoned: {e}"))?;
        (*guard).ok_or_else(|| "sidecar port not yet set".to_string())?
    };

    // Fetch the assembled snapshot over loopback (read-only GET; same surface as
    // proxy_fetch but parent-internal, not webview-facing).
    let url = format!("http://127.0.0.1:{port}/api/snapshot");
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} from /api/snapshot", resp.status()));
    }
    let mut snapshot: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    // Parent stamps freshness metadata (single authoritative writer).
    let seq = next_seq_value(read_current_seq(app));
    let writer = writer_id(app)?;
    stamp(&mut snapshot, seq, &writer);
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;

    // Resolve + coordinated write on ONE blocking thread so the Retained<NSURL>
    // never crosses threads (landmine #36).
    tauri::async_runtime::spawn_blocking(move || {
        match crate::icloud_writer::resolve_icloud_container() {
            Some(container) => crate::icloud_writer::write_snapshot_coordinated(&container, &bytes),
            None => Err("iCloud container vanished before write".to_string()),
        }
    })
    .await
    .map_err(|e| format!("write join failed: {e}"))??;

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
