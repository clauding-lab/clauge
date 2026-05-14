//! Bearer-token-authenticated HTTP client for api.anthropic.com OAuth endpoints.
//!
//! Primary call: GET /api/oauth/usage  → returns the user's plan-ring data.

use serde::Deserialize;

/// Empirically verified against api.anthropic.com/api/oauth/usage on 2026-05-14.
/// Percentages are 0..100 (NOT 0..1). Resets_at is ISO 8601 with timezone offset,
/// can be null (e.g. for fields without a fixed reset cadence). Unknown fields
/// land in `extra` via serde-flatten so future API additions don't break parsing.
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct PlanUsage {
    /// 5-hour session window utilization.
    pub five_hour: Option<UtilizationWindow>,
    /// 7-day rolling overall utilization.
    pub seven_day: Option<UtilizationWindow>,
    /// 7-day rolling utilization for OAuth API apps (separate from Claude Code direct usage).
    pub seven_day_oauth_apps: Option<UtilizationWindow>,
    /// 7-day rolling Opus-model utilization.
    pub seven_day_opus: Option<UtilizationWindow>,
    /// 7-day rolling Sonnet-model utilization.
    pub seven_day_sonnet: Option<UtilizationWindow>,
    /// 7-day rolling cowork (Claude internal experimental) utilization.
    pub seven_day_cowork: Option<UtilizationWindow>,
    /// 7-day rolling omelette (Claude internal experimental) utilization.
    pub seven_day_omelette: Option<UtilizationWindow>,
    /// Tangelo (internal Anthropic codename) utilization, when applicable.
    pub tangelo: Option<UtilizationWindow>,
    /// Iguana-necktie (internal Anthropic codename) utilization, when applicable.
    pub iguana_necktie: Option<UtilizationWindow>,
    /// Omelette promotional (internal Anthropic codename) utilization.
    pub omelette_promotional: Option<UtilizationWindow>,
    /// Prepaid extra-usage credit balance + cap.
    pub extra_usage: Option<ExtraUsage>,
    /// Catch-all for unknown fields — preserves forward compatibility as the
    /// Anthropic OAuth response shape evolves.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct UtilizationWindow {
    /// Percentage of the window consumed, 0..100.
    pub utilization: f64,
    /// ISO 8601 datetime when this window resets. May be null for windows
    /// without a fixed cadence (e.g. promotional or experimental fields).
    pub resets_at: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(default)]
pub struct ExtraUsage {
    /// Whether the user has opted in to API-extra-usage credit purchases.
    pub is_enabled: bool,
    /// Monthly cap in `currency` units (e.g. 1000 USD).
    pub monthly_limit: u32,
    /// Credits drawn against the cap so far this month.
    pub used_credits: f64,
    /// Percentage of monthly_limit consumed, 0..100. Null when the cap is
    /// configured but no usage has been recorded yet.
    pub utilization: Option<f64>,
    /// ISO 4217 currency code (typically "USD").
    pub currency: String,
    /// If the user disabled extra-usage purchases, the human-readable reason.
    pub disabled_reason: Option<String>,
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
