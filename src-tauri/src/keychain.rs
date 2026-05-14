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

#[derive(Deserialize, Clone)]
pub struct ClaudeCodeCreds {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// ISO 8601 datetime; absence means "always assume valid until 401".
    pub expires_at: Option<String>,
}

impl std::fmt::Debug for ClaudeCodeCreds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeCodeCreds")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at", &self.expires_at)
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
    #[error("security-framework error: {0}")]
    Framework(String),
    #[error("not supported on this platform")]
    UnsupportedPlatform,
}

#[cfg(target_os = "macos")]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    use security_framework::passwords::get_generic_password;

    // service = "Claude Code-credentials". Account is empty/wildcard — Claude
    // Code CLI uses one entry per user; we read the first match.
    match get_generic_password("Claude Code-credentials", "") {
        Ok(blob) => {
            let creds: ClaudeCodeCreds = serde_json::from_slice(&blob)?;
            Ok(creds)
        }
        Err(e) => {
            // security-framework's error type doesn't have a clean kind enum;
            // we map by the underlying OSStatus code if accessible.
            let msg = e.to_string();
            if msg.contains("errSecItemNotFound") || msg.contains("-25300") {
                Err(KeychainError::NotFound)
            } else if msg.contains("errSecAuthFailed") || msg.contains("errSecUserDenied") {
                Err(KeychainError::AccessDenied)
            } else {
                Err(KeychainError::Framework(msg))
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    Err(KeychainError::UnsupportedPlatform)
}

/// Returns true if `expires_at` is in the past. Absent expiry returns false
/// (assume valid until a 401 disproves us).
pub fn is_expired(creds: &ClaudeCodeCreds) -> bool {
    let Some(expires_at) = &creds.expires_at else {
        return false;
    };
    let Ok(t) = chrono::DateTime::parse_from_rfc3339(expires_at) else {
        return false;
    };
    t.with_timezone(&chrono::Utc) < chrono::Utc::now()
}
