//! Composes the three independent auth/data surfaces (Claude Code keychain,
//! claude.ai webview session, browser extension heartbeat) into a single
//! status object the dashboard consumes via IPC.

use serde::Serialize;

/// How long ago the extension's last sync can have been for the connection
/// to count as "Active". Past this, the extension shows "Not Detected".
const EXTENSION_FRESHNESS_MINUTES: i64 = 10;

#[derive(Debug, Serialize, PartialEq, Eq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionState {
    /// Claude Code keychain entry exists and OAuth token is valid (B path).
    Authenticated,
    /// claude.ai webview cookie persisted (A path).
    SignedIn,
    /// Extension heartbeat fresh within freshness window (existing v0.5.1).
    Active,
    /// Claude Code CLI not installed / never logged in.
    NotInstalled,
    /// claude.ai not signed in via webview.
    NotConnected,
    /// Extension not detected (no heartbeat, no page marker).
    NotDetected,
    /// Stored cookie / token expired; user needs to re-auth.
    Expired,
}

/// v0.9.0 MAS: grant outcome for ~/.claude/ folder access. Serializes as
/// `"granted"` / `"not_granted"` via `rename_all = "snake_case"` so the
/// JSON wire format matches the Task 10 frontend contract.
#[cfg(feature = "mas")]
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum ClaudeDirGrantStatus {
    Granted,
    NotGranted,
}

/// v0.9.0 MAS: state of the user's grant for ~/.claude/ folder access.
/// Absent from DMG/NSIS payloads (frontend hides the row when missing —
/// see Task 10 connections.js).
///
/// `path` is `Some(...)` only when the security-scoped bookmark has been
/// resolved AND `MAS_CLAUDE_DIR` is populated (i.e. the sidecar supervisor
/// has acquired the scope for the current run).
#[cfg(feature = "mas")]
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub struct ClaudeCodeLogsState {
    pub status: ClaudeDirGrantStatus,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ConnectionStatus {
    pub claude_code: ConnectionState,
    pub claude_code_version: Option<String>,
    pub claude_ai: ConnectionState,
    pub extension: ConnectionState,
    pub extension_last_seen_at: Option<String>,
    /// v0.9.0 MAS: grant state for ~/.claude/ folder access. `None` on DMG/NSIS
    /// payloads (omitted from JSON by `skip_serializing_if`), so the frontend
    /// uses field-absence to hide the row outside the MAS flavor.
    #[cfg(feature = "mas")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_code_logs: Option<ClaudeCodeLogsState>,
}

impl ConnectionStatus {
    /// Returns true if at least one path can supply claude.ai plan-ring data.
    pub fn has_any_plan_data_source(&self) -> bool {
        matches!(self.claude_code, ConnectionState::Authenticated)
            || matches!(self.claude_ai, ConnectionState::SignedIn)
            || matches!(self.extension, ConnectionState::Active)
    }
}

/// Pure state-machine compositor. Inputs are detection signals; output is
/// the snapshot the dashboard consumes.
///
/// `claude_code_version` sentinels:
/// - `Some("authenticated")` → ConnectionState::Authenticated (token valid)
/// - `Some("expired")`       → ConnectionState::Expired (token past expires_at)
/// - `Some(other)`           → ConnectionState::Authenticated (forward-compat
///                              for future version-aware UI)
/// - `None`                  → ConnectionState::NotInstalled
pub fn compose_status(
    claude_code_version: Option<&str>,
    claude_ai_signed_in: bool,
    extension_last_seen: Option<String>,
) -> ConnectionStatus {
    let claude_code = match claude_code_version {
        Some("expired") => ConnectionState::Expired,
        Some(_) => ConnectionState::Authenticated,
        None => ConnectionState::NotInstalled,
    };
    let claude_ai = if claude_ai_signed_in {
        ConnectionState::SignedIn
    } else {
        ConnectionState::NotConnected
    };
    let extension = match &extension_last_seen {
        Some(ts) => {
            if let Ok(t) = chrono::DateTime::parse_from_rfc3339(ts) {
                let age = chrono::Utc::now().signed_duration_since(t.with_timezone(&chrono::Utc));
                if age.num_minutes() < EXTENSION_FRESHNESS_MINUTES {
                    ConnectionState::Active
                } else {
                    ConnectionState::NotDetected
                }
            } else {
                ConnectionState::NotDetected
            }
        }
        None => ConnectionState::NotDetected,
    };
    ConnectionStatus {
        claude_code,
        claude_code_version: claude_code_version.map(|s| s.to_string()),
        claude_ai,
        extension,
        extension_last_seen_at: extension_last_seen,
        // MAS flavor: pure compositor has no AppHandle to query the bookmark
        // store, so it defaults to None. The IPC handler in ipc.rs fills this
        // in after detect() / compose_status() returns.
        #[cfg(feature = "mas")]
        claude_code_logs: None,
    }
}

/// Live detection — runs all three probes and composes the result.
///
/// Takes a reference to the keychain cache so concurrent IPC calls share
/// a single cached `ClaudeCodeCreds` and don't each re-prompt the user.
/// Extension heartbeat is exposed by the existing /api/health endpoint,
/// which the Hono server populates. We pass through whatever the JSON
/// response contains; for this synchronous detect() call we pass None —
/// the IPC handler composes with the heartbeat at the call site.
pub fn detect(cache: &crate::keychain_cache::KeychainCache) -> ConnectionStatus {
    let cc_version = match cache.get_or_load() {
        Ok(creds) => {
            if crate::keychain::is_expired(&creds) {
                Some("expired") // → compositor returns ConnectionState::Expired
            } else {
                // Version isn't in the credential blob; we surface a placeholder string.
                Some("authenticated")
            }
        }
        Err(e) => {
            log::warn!("connections::detect: credential read failed: {:?}", e);
            None
        }
    };

    let claude_ai = crate::claude_ai_session::read_stored_cookie().is_ok();

    compose_status(cc_version, claude_ai, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compose_status_with_expired_marker_yields_expired_state() {
        // Caller signals "credentials exist but expired" by passing
        // a sentinel string. The pure compositor recognizes it and
        // emits ConnectionState::Expired (not Authenticated, not NotInstalled).
        let s = compose_status(Some("expired"), false, None);
        assert_eq!(s.claude_code, ConnectionState::Expired);
        // claude_code_version field still echoes the sentinel for now (logging).
        assert_eq!(s.claude_code_version.as_deref(), Some("expired"));
    }
}
