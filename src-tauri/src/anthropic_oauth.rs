//! Bearer-token-authenticated HTTP client for api.anthropic.com OAuth endpoints.
//!
//! Primary call: GET /api/oauth/usage  → returns the user's plan-ring data.
//!
//! ⚠ Response shape is OSS-community-documented; PlanUsage is permissive
//! (Option<f64> for each field) so unknown/missing keys don't break parsing.
//! Phase 2 Task 6 inspects the live response and pins exact fields.

use serde::Deserialize;

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct PlanUsage {
    /// 5-hour session window utilization, 0.0..1.0.
    pub five_hour_limit_pct: Option<f64>,
    /// 7-day rolling utilization, 0.0..1.0.
    pub weekly_limit_pct: Option<f64>,
    /// Per-model breakdown if present in response.
    pub models: Option<ModelBreakdown>,
    /// Catch-all for unknown fields (preserved for future spec adjustments).
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct ModelBreakdown {
    pub sonnet: Option<ModelEntry>,
    pub opus: Option<ModelEntry>,
    pub haiku: Option<ModelEntry>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct ModelEntry {
    pub weekly_pct: Option<f64>,
}

#[derive(Debug, thiserror::Error)]
pub enum OAuthError {
    #[error("OAuth access token expired or invalid (got 401)")]
    TokenExpired,
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("response parse error: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("unexpected status {0}: {1}")]
    UnexpectedStatus(u16, String),
}

fn base_url() -> String {
    std::env::var("CLAUGE_ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".to_string())
}

pub async fn fetch_oauth_usage(access_token: &str) -> Result<PlanUsage, OAuthError> {
    let url = format!("{}/api/oauth/usage", base_url());
    // TODO(v0.7.1): replace with shared timeout-configured client.
    // reqwest::Client::new() has no default timeout — a slow claude.ai
    // response would hang the connections refresh.
    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .bearer_auth(access_token)
        .header("anthropic-version", "2023-06-01")
        .header("user-agent", concat!("Clauge/", env!("CARGO_PKG_VERSION")))
        .send()
        .await?;

    let status = res.status();
    if status.as_u16() == 401 {
        return Err(OAuthError::TokenExpired);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(OAuthError::UnexpectedStatus(status.as_u16(), body));
    }

    let body = res.text().await?;
    let usage: PlanUsage = serde_json::from_str(&body)?;
    Ok(usage)
}

/// Fetch the prepaid balance, if Anthropic exposes such an endpoint via OAuth.
///
/// The exact path is unverified; see Phase 2 Task 6 for empirical confirmation.
///
/// Returns:
/// - `Ok(None)` when the endpoint responds 404 (not exposed for this account/tier).
/// - `Ok(Some(value))` on 200 with the parsed JSON body (which itself may be `Value::Null`).
/// - `Err(OAuthError::TokenExpired)` on 401.
/// - `Err(OAuthError::UnexpectedStatus(_, _))` for any other non-success status.
pub async fn fetch_prepaid_balance(
    access_token: &str,
) -> Result<Option<serde_json::Value>, OAuthError> {
    let url = format!("{}/api/oauth/balance", base_url());
    // TODO(v0.7.1): replace with shared timeout-configured client.
    // reqwest::Client::new() has no default timeout — a slow claude.ai
    // response would hang the connections refresh.
    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .bearer_auth(access_token)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await?;
    if res.status().as_u16() == 401 {
        return Err(OAuthError::TokenExpired);
    }
    if res.status().as_u16() == 404 {
        // Endpoint may not be exposed for this account/tier; distinguish from a literal null body.
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(OAuthError::UnexpectedStatus(
            res.status().as_u16(),
            res.text().await.unwrap_or_default(),
        ));
    }
    Ok(Some(res.json().await?))
}
