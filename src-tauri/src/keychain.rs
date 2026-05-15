//! Claude Code OAuth credentials reader.
//!
//! Anthropic's Claude Code CLI persists OAuth tokens under the service name
//! "Claude Code-credentials" — on macOS via Keychain Services (this module's
//! historical reason for being called `keychain`), on Windows via a JSON file
//! at `%USERPROFILE%\.claude\.credentials.json`. The blob schema is identical
//! across platforms (verified empirically — see Phase 7 Task A notes at
//! `docs/superpowers/notes/2026-05-15-windows-claude-code-creds.md`).
//!
//! Blob shape (deserialized via `ClaudeCodeCreds`):
//!
//! ```text
//! { "claudeAiOauth": { "accessToken": "...", "refreshToken": "...",
//!                      "expiresAt": <unix-ms>, "scopes": [...],
//!                      "subscriptionType": "...", "rateLimitTier": "..." } }
//! ```
//!
//! macOS: first read on a fresh install triggers a Keychain access prompt.
//! User clicks "Always Allow" to silence subsequent reads. Cached via
//! `keychain_cache.rs` so we only hit Keychain Services once per launch.
//!
//! Windows: file-backed; no prompt, no cache strictly required, but
//! `keychain_cache.rs` still reduces filesystem reads on rapid polling.
//!
//! Linux: not supported (returns `UnsupportedPlatform`).

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
    #[error("filesystem error reading credentials: {0}")]
    Io(#[from] std::io::Error),
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

/// Windows: read Claude Code OAuth credentials from the per-user JSON file
/// at %USERPROFILE%\.claude\.credentials.json. The CLI persists the same blob
/// format Mac stores in Keychain Services (verified by Phase 7 Task A:
/// docs/superpowers/notes/2026-05-15-windows-claude-code-creds.md).
///
/// Note: the filename has a leading dot (`.credentials.json`, not
/// `credentials.json`) — Unix-style hidden-file convention that Claude Code
/// uses across platforms.
#[cfg(target_os = "windows")]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    let userprofile = std::env::var("USERPROFILE").map_err(|e| KeychainError::Framework {
        code: 0,
        message: format!("USERPROFILE env var not set: {}", e),
    })?;
    let path = std::path::PathBuf::from(userprofile)
        .join(".claude")
        .join(".credentials.json");
    read_from_path(&path)
}

/// Internal: read + parse the credentials file at a given path. Factored out
/// so tests can exercise the parse/error logic with a temp file.
#[cfg(target_os = "windows")]
fn read_from_path(path: &std::path::Path) -> Result<ClaudeCodeCreds, KeychainError> {
    let blob = std::fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => KeychainError::NotFound,
        std::io::ErrorKind::PermissionDenied => KeychainError::AccessDenied,
        _ => KeychainError::Io(e),
    })?;
    let creds: ClaudeCodeCreds = serde_json::from_slice(&blob)?;
    Ok(creds)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
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

#[cfg(test)]
#[cfg(target_os = "windows")]
mod windows_tests {
    use super::*;
    use std::io::Write;

    fn sample_creds_json() -> &'static str {
        r#"{"claudeAiOauth":{"accessToken":"a-token","refreshToken":"r-token","expiresAt":1900000000000,"scopes":["user:inference"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}"#
    }

    #[test]
    fn read_from_path_returns_not_found_for_missing_file() {
        let path = std::env::temp_dir().join(format!("clauge-test-missing-{}.json", std::process::id()));
        // Ensure it doesn't exist
        let _ = std::fs::remove_file(&path);
        let err = read_from_path(&path).expect_err("expected NotFound");
        assert!(matches!(err, KeychainError::NotFound), "got {:?}", err);
    }

    #[test]
    fn read_from_path_parses_valid_json() {
        let path = std::env::temp_dir().join(format!("clauge-test-valid-{}.json", std::process::id()));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(sample_creds_json().as_bytes()).unwrap();
        drop(f);

        let creds = read_from_path(&path).expect("read should succeed");
        assert_eq!(creds.claude_ai_oauth.access_token, "a-token");
        assert_eq!(creds.claude_ai_oauth.refresh_token.as_deref(), Some("r-token"));
        assert_eq!(creds.claude_ai_oauth.expires_at, Some(1_900_000_000_000));
        assert_eq!(creds.claude_ai_oauth.subscription_type.as_deref(), Some("max"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_from_path_returns_parse_error_for_garbage() {
        let path = std::env::temp_dir().join(format!("clauge-test-garbage-{}.json", std::process::id()));
        std::fs::write(&path, b"not valid json at all").unwrap();

        let err = read_from_path(&path).expect_err("expected Parse error");
        assert!(matches!(err, KeychainError::Parse(_)), "got {:?}", err);

        let _ = std::fs::remove_file(&path);
    }
}
