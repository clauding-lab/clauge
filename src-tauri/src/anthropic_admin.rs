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

use serde::{Deserialize, Serialize};

const ANTHROPIC_API_BASE: &str = "https://api.anthropic.com";
const USAGE_REPORT_PATH: &str = "/v1/organizations/usage_report/messages";

#[derive(Debug, thiserror::Error)]
pub enum AnthropicAdminError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API key is invalid format (must start with sk-ant-api03-)")]
    InvalidKeyFormat,
    #[error("API returned {status}: {body}")]
    ApiError { status: u16, body: String },
}

pub fn validate_key_format(key: &str) -> Result<(), AnthropicAdminError> {
    if key.starts_with("sk-ant-api03-") && key.len() > 20 {
        Ok(())
    } else {
        Err(AnthropicAdminError::InvalidKeyFormat)
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UsageReport {
    /// Daily breakdown rows. Shape per Anthropic API docs:
    /// https://docs.claude.com/en/api/admin-api/usage-cost/messages-usage-report
    pub data: Vec<serde_json::Value>,
    pub has_more: bool,
}

/// Test the API key by hitting the cheapest endpoint (the Usage Report endpoint
/// with `limit=1`). Returns Ok if the key is valid and the call succeeds; Err
/// otherwise.
pub async fn test_api_key(key: &str) -> Result<(), AnthropicAdminError> {
    validate_key_format(key)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    // Use yesterday as the date filter to ensure we have a fast empty response
    // even on new API accounts.
    let yesterday = chrono::Utc::now()
        .checked_sub_signed(chrono::Duration::days(1))
        .ok_or(AnthropicAdminError::ApiError {
            status: 0,
            body: "could not compute yesterday".to_string(),
        })?
        .format("%Y-%m-%dT00:00:00Z")
        .to_string();
    let url = format!(
        "{}{}?starting_at={}&limit=1",
        ANTHROPIC_API_BASE, USAGE_REPORT_PATH, yesterday
    );
    let res = client
        .get(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;
    let status = res.status().as_u16();
    if status == 200 {
        Ok(())
    } else {
        let body = res.text().await.unwrap_or_default();
        Err(AnthropicAdminError::ApiError { status, body })
    }
}

pub async fn fetch_usage_report(
    key: &str,
    starting_at: &str,
    ending_at: Option<&str>,
) -> Result<UsageReport, AnthropicAdminError> {
    validate_key_format(key)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let mut url = format!(
        "{}{}?starting_at={}",
        ANTHROPIC_API_BASE, USAGE_REPORT_PATH, starting_at
    );
    if let Some(end) = ending_at {
        url.push_str(&format!("&ending_at={}", end));
    }
    let res = client
        .get(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;
    let status = res.status().as_u16();
    if status != 200 {
        let body = res.text().await.unwrap_or_default();
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
        assert!(matches!(validate_key_format(""), Err(AnthropicAdminError::InvalidKeyFormat)));
    }

    #[test]
    fn validate_key_format_rejects_short() {
        assert!(matches!(validate_key_format("sk-ant-api03-"), Err(AnthropicAdminError::InvalidKeyFormat)));
    }

    #[test]
    fn validate_key_format_rejects_wrong_prefix() {
        assert!(matches!(validate_key_format("sk-proj-fakeopenaikey1234567890"), Err(AnthropicAdminError::InvalidKeyFormat)));
    }
}
