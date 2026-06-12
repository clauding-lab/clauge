//! Cross-platform alert poller/firer (Sub-Project B).
//!
//! Polls the always-on sidecar's `GET /api/alerts/pending` every 30s, fires
//! each due alert as an OS notification (`tauri-plugin-notification`, the
//! `ipc.rs:300` pattern), then `POST /api/alerts/ack`s the attempted ids +
//! the severity-collapsed `retire` keys so a key fires once per window
//! instance. NOT macOS-gated — Windows needs notifications too.
//!
//! The decision (thresholds + forecast collapse) lives in the sidecar's
//! `lib/alert-engine.js`; this file is a thin firer. Clock is owned by the
//! sidecar endpoint (it captures one `Date.now()` per tick); the Rust side
//! only drives the 30s cadence.

/// One alert the sidecar says is due to fire now. Mirrors the JS payload's
/// `{ id, type, window, title, body }`; the Rust firer only needs id (to ack),
/// title, and body (to show).
struct DueAlert {
    id: String,
    title: String,
    body: String,
}

/// Loopback URL for the side-effect-free pending read.
fn pending_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/alerts/pending")
}

/// Loopback URL for the fired/retired ack write.
fn ack_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/api/alerts/ack")
}

/// Parse the `due` array into `DueAlert`s. An entry missing `id`, `title`,
/// or `body` is dropped — we must never fire a notification we can't ack.
fn parse_due(json: &serde_json::Value) -> Vec<DueAlert> {
    let Some(arr) = json.get("due").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|a| {
            let id = a.get("id")?.as_str()?.to_string();
            let title = a.get("title")?.as_str()?.to_string();
            let body = a.get("body")?.as_str()?.to_string();
            Some(DueAlert { id, title, body })
        })
        .collect()
}

/// Parse the `retire` array into dedup keys. Non-string entries are dropped.
fn parse_retire(json: &serde_json::Value) -> Vec<String> {
    let Some(arr) = json.get("retire").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|v| v.as_str().map(|s| s.to_string()))
        .collect()
}

/// Spawn the always-on alert poller. Every 30s: GET `/api/alerts/pending`,
/// fire each due alert as an OS notification, then POST `/api/alerts/ack`
/// with the ids it ATTEMPTED (fired OR errored — a permission-denied
/// notification must not retry-spam every 30s) plus the severity-collapsed
/// `retire` keys. A tick with empty `due` AND empty `retire` skips the ack.
///
/// Cross-platform: Windows needs notifications too, so this is NOT
/// `#[cfg(target_os = "macos")]`. The mutation (marking fired) lives entirely
/// in the ack POST, so a crash before firing re-fires next tick
/// (at-least-once for real notifications).
pub fn spawn_alert_poller(app: tauri::AppHandle) {
    use tauri::Manager;
    use tauri_plugin_notification::NotificationExt;

    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;

            // Server-port resolution mirrors native_popover.rs:676-679.
            let port = app
                .try_state::<crate::ipc::AppState>()
                .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
            let Some(port) = port else { continue };

            // 1. Pending read (side-effect-free on the sidecar).
            let json = match crate::http_client::LOCAL_CLIENT
                .get(pending_url(port))
                .send()
                .await
            {
                Ok(resp) => match resp.json::<serde_json::Value>().await {
                    Ok(json) => json,
                    Err(e) => {
                        log::warn!("alerts: pending json parse failed: {e}");
                        continue;
                    }
                },
                Err(e) => {
                    log::warn!("alerts: pending fetch failed: {e}");
                    continue;
                }
            };

            let due = parse_due(&json);
            let retire = parse_retire(&json);

            // 2. Fire each due alert; collect the ids ATTEMPTED (fired or
            //    errored). A failed show() is still acked so it can't
            //    retry-spam every 30s.
            let mut attempted: Vec<String> = Vec::with_capacity(due.len());
            for alert in &due {
                if let Err(e) = app
                    .notification()
                    .builder()
                    .title(&alert.title)
                    .body(&alert.body)
                    .show()
                {
                    log::warn!("alerts: notification show() failed for {}: {e}", alert.id);
                }
                attempted.push(alert.id.clone());
            }

            // 3. Ack. Skip entirely if nothing was due and nothing retired.
            if attempted.is_empty() && retire.is_empty() {
                continue;
            }
            let ack_body = serde_json::json!({ "fired": attempted, "retired": retire });
            match crate::http_client::LOCAL_CLIENT
                .post(ack_url(port))
                .json(&ack_body)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {}
                Ok(resp) => {
                    log::warn!("alerts: ack POST returned status {}", resp.status());
                }
                Err(e) => {
                    log::warn!("alerts: ack POST failed: {e}");
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_url_targets_loopback_alerts_pending() {
        assert_eq!(
            pending_url(3456),
            "http://127.0.0.1:3456/api/alerts/pending"
        );
    }

    #[test]
    fn ack_url_targets_loopback_alerts_ack() {
        assert_eq!(ack_url(51123), "http://127.0.0.1:51123/api/alerts/ack");
    }

    #[test]
    fn parse_due_extracts_id_title_body_in_order() {
        let json: serde_json::Value = serde_json::json!({
            "due": [
                { "id": "approaching:fiveHour:80:2026-06-12T14:20:00+00:00",
                  "type": "approaching", "window": "fiveHour",
                  "title": "Clauge — 5-hour limit at 82%",
                  "body": "You're past 80% of your 5-hour window. Resets ~3:40 PM." },
                { "id": "limitReached:sevenDay:2026-06-19T00:00:00+00:00",
                  "title": "Clauge — weekly limit reached",
                  "body": "You've hit your weekly limit." }
            ],
            "retire": []
        });
        let due = parse_due(&json);
        assert_eq!(due.len(), 2);
        assert_eq!(
            due[0].id,
            "approaching:fiveHour:80:2026-06-12T14:20:00+00:00"
        );
        assert_eq!(due[0].title, "Clauge — 5-hour limit at 82%");
        assert_eq!(
            due[0].body,
            "You're past 80% of your 5-hour window. Resets ~3:40 PM."
        );
        assert_eq!(due[1].id, "limitReached:sevenDay:2026-06-19T00:00:00+00:00");
    }

    #[test]
    fn parse_due_skips_entries_missing_required_fields() {
        // An entry missing `id` (or title/body) is dropped — we never fire a
        // notification we can't ack by id.
        let json: serde_json::Value = serde_json::json!({
            "due": [
                { "title": "no id", "body": "x" },
                { "id": "willHit:fiveHour:2026-06-12T14:20:00+00:00",
                  "title": "Clauge — on pace to run out",
                  "body": "At this rate your 5-hour limit runs out before it resets." }
            ],
            "retire": []
        });
        let due = parse_due(&json);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "willHit:fiveHour:2026-06-12T14:20:00+00:00");
    }

    #[test]
    fn parse_due_empty_or_absent_yields_empty() {
        assert!(parse_due(&serde_json::json!({ "retire": [] })).is_empty());
        assert!(parse_due(&serde_json::json!({ "due": [] })).is_empty());
        assert!(parse_due(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn parse_retire_extracts_string_keys_only() {
        let json: serde_json::Value = serde_json::json!({
            "due": [],
            "retire": [
                "approaching:fiveHour:95:2026-06-12T14:20:00+00:00",
                "approaching:fiveHour:80:2026-06-12T14:20:00+00:00",
                42
            ]
        });
        let retire = parse_retire(&json);
        // The non-string `42` is dropped defensively.
        assert_eq!(
            retire,
            vec![
                "approaching:fiveHour:95:2026-06-12T14:20:00+00:00".to_string(),
                "approaching:fiveHour:80:2026-06-12T14:20:00+00:00".to_string(),
            ]
        );
    }

    #[test]
    fn parse_retire_absent_yields_empty() {
        assert!(parse_retire(&serde_json::json!({ "due": [] })).is_empty());
    }
}
