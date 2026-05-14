//! macOS Keychain Services wrapper for the Claude Code OAuth credentials entry.
//!
//! Service name: "Claude Code-credentials" (written by Anthropic's official
//! Claude Code CLI when the user runs `claude /login`).
//!
//! Blob format (empirically observed; verified during Phase 2 manual smoke):
//!     { "access_token": "...", "refresh_token": "...", "expires_at": "ISO8601", ... }
//!
//! First read on a given user account triggers a macOS Keychain access prompt
//! ("Clauge wants to use your confidential information stored in 'Claude Code-
//! credentials' in your keychain"). User clicks "Always Allow" to silence
//! subsequent prompts.
//!
//! On non-macOS targets the entire module is a no-op (the dependency
//! `security-framework` is gated to macOS).

use serde::Deserialize;

/// The Keychain Services service name Claude Code CLI writes its OAuth blob to.
/// Stable across Claude Code versions (verified 2026-05-14).
pub const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// Wrapper for the actual Claude Code keychain blob. The blob has a
/// `claudeAiOauth` top-level key (camelCase) plus an unrelated `mcpOAuth`
/// section we ignore. Empirically verified 2026-05-14 against a live
/// `Claude Code-credentials` entry.
#[derive(Deserialize, Clone)]
pub struct ClaudeCodeCreds {
    #[serde(rename = "claudeAiOauth")]
    pub claude_ai_oauth: ClaudeAiOauth,
}

/// The actual OAuth credentials Anthropic's CLI persists.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAiOauth {
    /// Bearer token for api.anthropic.com OAuth endpoints. Long-lived but
    /// not infinite; check `expires_at` against now() to gauge freshness.
    pub access_token: String,
    /// Used to refresh `access_token` when it expires. May be absent for
    /// session-only auths.
    pub refresh_token: Option<String>,
    /// Unix epoch in MILLISECONDS when `access_token` becomes invalid.
    /// (NOT seconds, NOT ISO 8601 — confirmed empirically.)
    pub expires_at: Option<i64>,
    /// OAuth scopes granted to Claude Code; informational.
    pub scopes: Option<Vec<String>>,
    /// Anthropic subscription tier — e.g. "max", "pro", "free".
    pub subscription_type: Option<String>,
    /// Rate-limit bucket Anthropic assigns — e.g. "default_claude_max_20x".
    pub rate_limit_tier: Option<String>,
}

impl std::fmt::Debug for ClaudeCodeCreds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeCodeCreds")
            .field("claude_ai_oauth", &self.claude_ai_oauth)
            .finish()
    }
}

impl std::fmt::Debug for ClaudeAiOauth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeAiOauth")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes)
            .field("subscription_type", &self.subscription_type)
            .field("rate_limit_tier", &self.rate_limit_tier)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("Claude Code keychain entry not found (user may not have run `claude /login`)")]
    NotFound,
    #[error("keychain access denied (user clicked Deny on the prompt)")]
    AccessDenied,
    #[error("failed to parse keychain blob as JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("security-framework error (OSStatus {code}): {message}")]
    Framework { code: i32, message: String },
    #[error("not supported on this platform")]
    UnsupportedPlatform,
}

/// Map a raw macOS Security framework OSStatus to a structured KeychainError.
/// Known codes:
/// - errSecItemNotFound (-25300) → NotFound
/// - errSecUserCanceled (-128)   → AccessDenied
/// - errSecAuthFailed (-25293)   → AccessDenied (user denied or auth flow failed)
/// Anything else falls through to Framework { code, message }.
#[cfg(target_os = "macos")]
fn map_osstatus_to_error(code: i32, msg: &str) -> KeychainError {
    match code {
        -25300 => KeychainError::NotFound,
        -128 | -25293 => KeychainError::AccessDenied,
        _ => KeychainError::Framework {
            code,
            message: msg.to_string(),
        },
    }
}

#[cfg(target_os = "macos")]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit, SearchResult};

    // Claude Code CLI writes its OAuth entry with account = <macOS short username>
    // (e.g. "adnanrashid"). We don't want to hardcode the account, so we search by
    // service only and take the first match. This mirrors the behavior of:
    //   security find-generic-password -s "Claude Code-credentials" -w
    let search = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(KEYCHAIN_SERVICE)
        .load_data(true)
        .limit(Limit::Max(1))
        .search();

    let results = match search {
        Ok(r) => r,
        Err(e) => {
            // security-framework 2.x exposes the raw OSStatus via Error::code().
            // Use that instead of fragile substring matching on the formatted message.
            let code = e.code();
            return Err(map_osstatus_to_error(code, &e.to_string()));
        }
    };

    // No matches → NotFound (search returned empty Ok).
    let first = results.into_iter().next().ok_or(KeychainError::NotFound)?;

    // Extract the password bytes. With load_data(true), expect SearchResult::Data.
    let blob: Vec<u8> = match first {
        SearchResult::Data(bytes) => bytes,
        other => {
            // Not an OSStatus error — this is an internal invariant violation
            // (we asked for Data via load_data(true) but got something else).
            // Use code=0 (errSecSuccess) as a sentinel since there's no real status.
            return Err(KeychainError::Framework {
                code: 0,
                message: format!("unexpected SearchResult variant (expected Data): {:?}", other),
            });
        }
    };

    let creds: ClaudeCodeCreds = serde_json::from_slice(&blob)?;
    Ok(creds)
}

#[cfg(not(target_os = "macos"))]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    Err(KeychainError::UnsupportedPlatform)
}

/// Returns true if `expires_at` is in the past. Absent expiry returns false
/// (assume valid until a 401 disproves us).
pub fn is_expired(creds: &ClaudeCodeCreds) -> bool {
    let Some(expires_at_ms) = creds.claude_ai_oauth.expires_at else {
        return false;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    expires_at_ms < now_ms
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    #[test]
    fn errno_minus_25300_maps_to_not_found() {
        // errSecItemNotFound = -25300
        let err = map_osstatus_to_error(-25300, "test");
        assert!(matches!(err, KeychainError::NotFound), "got {:?}", err);
    }

    #[test]
    fn errno_minus_128_maps_to_access_denied() {
        // errSecUserCanceled = -128
        let err = map_osstatus_to_error(-128, "test");
        assert!(matches!(err, KeychainError::AccessDenied), "got {:?}", err);
    }

    #[test]
    fn errno_unknown_maps_to_framework() {
        let err = map_osstatus_to_error(-99999, "boom");
        match err {
            KeychainError::Framework { code, message } => {
                assert_eq!(code, -99999);
                assert_eq!(message, "boom");
            }
            other => panic!("expected Framework variant, got {:?}", other),
        }
    }

    #[test]
    fn errno_minus_25293_maps_to_access_denied() {
        // errSecAuthFailed = -25293
        let err = map_osstatus_to_error(-25293, "test");
        assert!(matches!(err, KeychainError::AccessDenied), "got {:?}", err);
    }
}
