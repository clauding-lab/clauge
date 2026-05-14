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

#[derive(Debug, Serialize, Clone)]
pub struct ConnectionStatus {
    pub claude_code: ConnectionState,
    pub claude_code_version: Option<String>,
    pub claude_ai: ConnectionState,
    pub extension: ConnectionState,
    pub extension_last_seen_at: Option<String>,
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
pub fn compose_status(
    claude_code_version: Option<&str>,
    claude_ai_signed_in: bool,
    extension_last_seen: Option<String>,
) -> ConnectionStatus {
    let claude_code = match claude_code_version {
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
    }
}

/// Live detection — runs all three probes and composes the result.
pub fn detect() -> ConnectionStatus {
    #[cfg(target_os = "macos")]
    let cc_version = match crate::keychain::read_claude_code_credentials() {
        Ok(creds) => {
            if crate::keychain::is_expired(&creds) {
                None // treat expired as not installed for now; refresh-token flow is future work.
            } else {
                // Version isn't in the credential blob; we surface a placeholder string.
                Some("authenticated")
            }
        }
        Err(_) => None,
    };
    #[cfg(not(target_os = "macos"))]
    let cc_version: Option<&str> = None;

    let claude_ai = crate::claude_ai_session::read_stored_cookie().is_ok();

    // Extension heartbeat is exposed by the existing /api/health endpoint,
    // which the Hono server populates. We pass through whatever the JSON
    // response contains; live detection-via-IPC is wired in Task 10.
    // For this synchronous detect() call we read None — the IPC handler
    // composes with the heartbeat at the call site.
    compose_status(cc_version, claude_ai, None)
}
