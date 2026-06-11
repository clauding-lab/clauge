//! Sync-health derivation + wire type for the iCloud upload-confirmation
//! signal (v1.2.0 Item 4). Mirrors `connections.rs::ConnectionStatus` /
//! `ConnectionState`: a `#[derive(Serialize)]` struct + a `snake_case`
//! string-tagged enum, plus a PURE derivation function unit-tested below.
//!
//! The honest wedge detector is `upload_error` (Apple's
//! NSURLUbiquitousItemUploadingErrorKey present). `upload_ok`
//! (NSURLUbiquitousItemIsUploadedKey) is the last-known-delivered flag and
//! reads `false` right after a fresh write, so it is NEVER treated as a
//! failure on its own — only as the input to the 24h staleness boundary.

#![cfg(target_os = "macos")]

use serde::Serialize;

/// Staleness boundary: no confirmed upload in this many seconds → `Stale`.
const STALE_AFTER_SECS: i64 = 24 * 60 * 60;

/// Wire-level health state for the iCloud → iPhone publish path.
/// `snake_case` lowercases each variant to match the `connections.rs`
/// `ConnectionState` convention the dashboard already consumes.
#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum SyncHealthState {
    /// Latest snapshot confirmed uploaded within the staleness window.
    Ok,
    /// Written, no error, upload not yet confirmed — fresh (eventually consistent).
    Pending,
    /// iCloud reported an uploading error on the previous cycle's file (the wedge).
    Error,
    /// No confirmed upload in 24h+ and no hard error — likely silently stuck.
    Stale,
    /// Publishing disabled / not signed into iCloud / no data yet.
    Unknown,
}

/// Snapshot of the publish path's health, read from persisted state by the
/// `get_sync_health` IPC. Mirrors `ConnectionStatus`: a flat `Serialize`
/// struct with `camelCase` JSON keys for the dashboard.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncHealth {
    pub state: SyncHealthState,
    pub last_seq: Option<u64>,
    pub last_published_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Pure: derive the health state from the previous cycle's read.
///
/// * `upload_ok`    — NSURLUbiquitousItemIsUploadedKey (last-known delivered).
/// * `upload_error` — NSURLUbiquitousItemUploadingErrorKey present (the wedge).
/// * `age_secs`     — seconds since `lastPublishedAt` (None = nothing published yet).
///
/// Precedence: a hard error wins; then no-data; then the 24h staleness
/// boundary; then confirmed-vs-pending.
pub fn derive_state(upload_ok: bool, upload_error: bool, age_secs: Option<i64>) -> SyncHealthState {
    if upload_error {
        return SyncHealthState::Error;
    }
    let Some(age) = age_secs else {
        return SyncHealthState::Unknown;
    };
    if age > STALE_AFTER_SECS {
        return SyncHealthState::Stale;
    }
    if upload_ok {
        SyncHealthState::Ok
    } else {
        SyncHealthState::Pending
    }
}

/// Generic, privacy-safe detail for the `Error` state. Apple's raw
/// `UploadingError` can read "Couldn't access your iCloud account…" and must
/// NOT be echoed (AGENTS landmine #34) — map every upload error to this.
pub const UPLOAD_ERROR_DETAIL: &str =
    "iCloud upload issue — check that iCloud Drive is signed in and working.";

#[cfg(test)]
mod tests {
    use super::*;

    /// 24h boundary is the staleness threshold (in seconds).
    const DAY_SECS: i64 = 24 * 60 * 60;

    #[test]
    fn upload_error_present_is_error_regardless_of_age_or_flag() {
        // The wedge: write succeeded but iCloud reports an uploading error.
        let s = derive_state(true, true, Some(10));
        assert_eq!(s, SyncHealthState::Error);
        let s2 = derive_state(false, true, Some(DAY_SECS * 5));
        assert_eq!(s2, SyncHealthState::Error);
    }

    #[test]
    fn no_data_yet_is_unknown() {
        // No previous publish recorded (age None, no flags meaningful).
        assert_eq!(derive_state(false, false, None), SyncHealthState::Unknown);
    }

    #[test]
    fn confirmed_recent_upload_is_ok() {
        assert_eq!(derive_state(true, false, Some(60)), SyncHealthState::Ok);
        assert_eq!(
            derive_state(true, false, Some(DAY_SECS - 1)),
            SyncHealthState::Ok
        );
    }

    #[test]
    fn not_yet_confirmed_recent_is_pending() {
        // Written, no error, upload not confirmed yet, still fresh.
        assert_eq!(
            derive_state(false, false, Some(60)),
            SyncHealthState::Pending
        );
    }

    #[test]
    fn no_confirmed_upload_past_24h_is_stale() {
        // Past the boundary with no confirmed delivery and no hard error.
        assert_eq!(
            derive_state(false, false, Some(DAY_SECS + 1)),
            SyncHealthState::Stale
        );
        // A previously-confirmed upload that has since gone 24h+ without a
        // fresh confirmation is also stale.
        assert_eq!(
            derive_state(true, false, Some(DAY_SECS + 1)),
            SyncHealthState::Stale
        );
    }

    #[test]
    fn serializes_with_lowercase_state_tag_and_camel_fields() {
        let h = SyncHealth {
            state: SyncHealthState::Ok,
            last_seq: Some(7),
            last_published_at: Some(1_700_000_000),
            detail: None,
        };
        let v = serde_json::to_value(&h).unwrap();
        assert_eq!(v["state"], serde_json::json!("ok"));
        assert_eq!(v["lastSeq"], serde_json::json!(7));
        assert_eq!(v["lastPublishedAt"], serde_json::json!(1_700_000_000_i64));
        // `detail: None` is omitted from the wire (skip_serializing_if).
        assert!(v.get("detail").is_none());
    }
}
