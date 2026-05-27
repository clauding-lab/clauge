//! API-key-authenticated client for the Anthropic Usage and Cost API.
//!
//! This is the ToS-clean opt-in path for plan-ring data. The user generates
//! an `sk-ant-api03-*` API key at https://console.anthropic.com/settings/keys
//! and pastes it into Settings. We store it in our own Keychain entry
//! (`com.clauding.clauge.anthropic-admin-key`) and use it to call
//! `api.anthropic.com/v1/organizations/usage_report/messages`.
//!
//! Coexists with `anthropic_oauth.rs`: when an Admin API key is set, the
//! picker (see ipc.rs Task 11) prefers this module; when unset, OAuth
//! fallback runs. Per 2026-05-27 pivot.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const ANTHROPIC_API_BASE_DEFAULT: &str = "https://api.anthropic.com";
const USAGE_REPORT_PATH: &str = "/v1/organizations/usage_report/messages";

/// Shared timeout-configured reqwest client for the Admin API. Mirrors
/// the OAUTH_CLIENT pattern in anthropic_oauth.rs — bakes in the Clauge
/// user-agent so Anthropic can attribute requests, and reuses the
/// underlying connection pool across the dashboard's ~30s polling.
pub(crate) static ADMIN_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Clauge/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest::Client::build is infallible without a custom config")
});

/// Base URL for api.anthropic.com. Overridable via CLAUGE_ANTHROPIC_BASE_URL
/// so integration tests can substitute a mockito server. Matches the OAuth
/// module's pattern.
fn base_url() -> String {
    std::env::var("CLAUGE_ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| ANTHROPIC_API_BASE_DEFAULT.to_string())
}

fn truncate_body(body: String) -> String {
    if body.len() > 500 {
        let mut s = body.chars().take(500).collect::<String>();
        s.push_str("…[truncated]");
        s
    } else {
        body
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AnthropicAdminError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API key is invalid format (must start with sk-ant-api03-)")]
    InvalidKeyFormat,
    #[error("API returned {status}: {body}")]
    ApiError { status: u16, body: String },
}

/// Maximum accepted key length. Mirrors the JS CLI cap
/// (`lib/cli/config-set-api-key.js::MAX_KEY_LENGTH`) so a multi-MB paste
/// can't sneak in via the dashboard IPC path while the CLI rejects it.
const MAX_KEY_LENGTH: usize = 4096;

pub fn validate_key_format(key: &str) -> Result<(), AnthropicAdminError> {
    if !key.starts_with("sk-ant-api03-") || key.len() <= 20 {
        return Err(AnthropicAdminError::InvalidKeyFormat);
    }
    if key.len() > MAX_KEY_LENGTH {
        return Err(AnthropicAdminError::InvalidKeyFormat);
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UsageReport {
    /// Daily breakdown rows. Shape per Anthropic API docs:
    /// https://docs.claude.com/en/api/admin-api/usage-cost/messages-usage-report
    // TODO(task-11): type this once consumed by picker
    pub data: Vec<serde_json::Value>,
    pub has_more: bool,
}

/// Test the API key by hitting the cheapest endpoint (the Usage Report endpoint
/// with `limit=1`). Returns Ok if the key is valid and the call succeeds; Err
/// otherwise.
pub async fn test_api_key(key: &str) -> Result<(), AnthropicAdminError> {
    validate_key_format(key)?;
    // Use yesterday as the date filter to ensure we have a fast empty response
    // even on new API accounts.
    let yesterday = chrono::Utc::now()
        .checked_sub_signed(chrono::Duration::days(1))
        .expect("Utc::now() minus 1 day cannot overflow i64")
        .format("%Y-%m-%dT00:00:00Z")
        .to_string();
    let url = format!(
        "{}{}?starting_at={}&limit=1",
        base_url(),
        USAGE_REPORT_PATH,
        yesterday
    );
    let res = ADMIN_CLIENT
        .get(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;
    let status = res.status().as_u16();
    if status == 200 {
        Ok(())
    } else {
        let body = truncate_body(res.text().await.unwrap_or_default());
        Err(AnthropicAdminError::ApiError { status, body })
    }
}

pub async fn fetch_usage_report(
    key: &str,
    starting_at: &str,
    ending_at: Option<&str>,
) -> Result<UsageReport, AnthropicAdminError> {
    validate_key_format(key)?;
    let mut url = format!(
        "{}{}?starting_at={}",
        base_url(),
        USAGE_REPORT_PATH,
        starting_at
    );
    if let Some(end) = ending_at {
        url.push_str(&format!("&ending_at={}", end));
    }
    let res = ADMIN_CLIENT
        .get(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;
    let status = res.status().as_u16();
    if status != 200 {
        let body = truncate_body(res.text().await.unwrap_or_default());
        return Err(AnthropicAdminError::ApiError { status, body });
    }
    Ok(res.json().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_key_format_accepts_valid_prefix() {
        assert!(validate_key_format("sk-ant-api03-abc123XYZ7890-fakekeyfortesting").is_ok());
    }

    #[test]
    fn validate_key_format_rejects_empty() {
        assert!(matches!(
            validate_key_format(""),
            Err(AnthropicAdminError::InvalidKeyFormat)
        ));
    }

    #[test]
    fn validate_key_format_rejects_short() {
        assert!(matches!(
            validate_key_format("sk-ant-api03-"),
            Err(AnthropicAdminError::InvalidKeyFormat)
        ));
    }

    #[test]
    fn validate_key_format_rejects_wrong_prefix() {
        assert!(matches!(
            validate_key_format("sk-proj-fakeopenaikey1234567890"),
            Err(AnthropicAdminError::InvalidKeyFormat)
        ));
    }

    #[test]
    fn validate_key_format_rejects_oversized() {
        let huge = format!("sk-ant-api03-{}", "x".repeat(5000));
        assert!(matches!(
            validate_key_format(&huge),
            Err(AnthropicAdminError::InvalidKeyFormat)
        ));
    }
}
