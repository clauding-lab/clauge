//! In-app WKWebView modal for claude.ai login (Architecture A fallback).
//!
//! Opens https://claude.ai/login in a small Tauri WebviewWindow. User signs
//! in normally (Google, email, passkey). On post-login navigation, we extract
//! the sessionKey cookie and persist to Keychain Services under our own
//! service name. Subsequent claude.ai/api/.../usage HTTP calls inject this
//! cookie via the Cookie header.
//!
//! Sandbox compatibility: WKWebView is sandboxed by default; the only sandbox
//! entitlement needed is com.apple.security.network.client (already in
//! entitlements.mas.plist).

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const AUTH_WINDOW_LABEL: &str = "auth-claude-ai";
const SESSION_KEYCHAIN_SERVICE: &str = "com.clauding.clauge.claude-ai-session";

/// Polling interval for cookie capture after the user reaches a post-login
/// claude.ai page. 1.5s is conservative — captures within the first
/// JS-frame after navigation in most cases.
const COOKIE_CAPTURE_POLL_MS: u64 = 1500;

/// Maximum number of polls before giving up. 40 × 1.5s = 60s total wall clock.
/// Past this, the auth window is closed and a `cookie-capture-timeout` event
/// is emitted so the frontend can show "Sign-in didn't complete — please try again."
const MAX_COOKIE_CAPTURE_ATTEMPTS: usize = 40;

#[derive(Debug, thiserror::Error)]
pub enum ClaudeAiError {
    #[error("tauri webview error: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("session cookie not found after login")]
    CookieNotFound,
    #[error("keychain write failed: {0}")]
    KeychainWrite(String),
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("not authenticated (no stored cookie)")]
    NotAuthenticated,
}

/// Open the auth modal and resolve when login completes (cookie captured).
pub async fn open_login_modal(app: &AppHandle) -> Result<(), ClaudeAiError> {
    // If a window with this label already exists, focus it instead.
    if let Some(w) = app.get_webview_window(AUTH_WINDOW_LABEL) {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(
        app,
        AUTH_WINDOW_LABEL,
        WebviewUrl::External("https://claude.ai/login".parse().unwrap()),
    )
    .title("Sign in to Claude")
    .inner_size(520.0, 720.0)
    .resizable(false)
    .skip_taskbar(true)
    .build()?;

    // Poll for navigation completion every 1.5s while the window is open.
    // Capture cookie on any claude.ai navigation that ISN'T a login surface
    // (/login, /oauth/*, /auth/*). The post-login URL varies (/, /new,
    // /chats, /chat/<id>, /projects, /settings, ...) — listing them
    // positively misses cases; "any non-login claude.ai page" is robust.
    let win_for_poll = win.clone();
    let app_for_poll = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut attempts: usize = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(COOKIE_CAPTURE_POLL_MS)).await;
            attempts += 1;
            if app_for_poll.get_webview_window(AUTH_WINDOW_LABEL).is_none() {
                // User closed the auth window manually — exit cleanly.
                break;
            }
            if attempts > MAX_COOKIE_CAPTURE_ATTEMPTS {
                log::warn!(
                    "claude_ai_session: cookie capture timed out after {} attempts ({}s)",
                    MAX_COOKIE_CAPTURE_ATTEMPTS,
                    MAX_COOKIE_CAPTURE_ATTEMPTS as u64 * COOKIE_CAPTURE_POLL_MS / 1000
                );
                let _ = app_for_poll.emit("cookie-capture-timeout", ());
                if let Some(w) = app_for_poll.get_webview_window(AUTH_WINDOW_LABEL) {
                    let _ = w.close();
                }
                break;
            }
            if let Ok(url) = win_for_poll.url() {
                let host = url.host_str();
                let path = url.path();
                let is_claude_ai = host == Some("claude.ai");
                let is_login_surface = path == "/login"
                    || path.starts_with("/login/")
                    || path.starts_with("/oauth/")
                    || path.starts_with("/auth/");
                if is_claude_ai && !is_login_surface {
                    match capture_session_cookie(&win_for_poll) {
                        Ok(_) => {
                            log::info!(
                                "claude_ai_session: captured sessionKey on {}{}",
                                host.unwrap_or("?"),
                                path
                            );
                            let _ = app_for_poll.emit("connections-updated", ());
                            let _ = win_for_poll.close();
                            break;
                        }
                        Err(e) => {
                            log::debug!(
                                "claude_ai_session: post-login on {}{} but cookie capture failed: {:?}",
                                host.unwrap_or("?"),
                                path,
                                e
                            );
                        }
                    }
                }
            }
        }
    });

    Ok(())
}

/// Synchronous cookie capture — Tauri 2.11 exposes `cookies_for_url` as a
/// non-async method that returns `tauri::Result<Vec<Cookie<'static>>>`. The
/// plan draft showed an `.await?` which would not compile against the real
/// API; this version drops the await. Called from a spawned task so the
/// (potentially blocking on Windows per upstream issue, see Tauri docs)
/// runtime read does not stall the UI thread.
fn capture_session_cookie(win: &tauri::WebviewWindow) -> Result<String, ClaudeAiError> {
    let cookies = win.cookies_for_url("https://claude.ai".parse().unwrap())?;
    let session_cookie = cookies
        .iter()
        .find(|c| c.name() == "sessionKey")
        .ok_or(ClaudeAiError::CookieNotFound)?;
    let value = session_cookie.value().to_string();

    // Persist to Keychain Services under our own service name.
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::set_generic_password;
        set_generic_password(SESSION_KEYCHAIN_SERVICE, "default", value.as_bytes())
            .map_err(|e| ClaudeAiError::KeychainWrite(e.to_string()))?;
    }

    Ok(value)
}

/// Read the persisted session cookie. Returns NotAuthenticated if absent.
pub fn read_stored_cookie() -> Result<String, ClaudeAiError> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::get_generic_password;
        let blob = get_generic_password(SESSION_KEYCHAIN_SERVICE, "default")
            .map_err(|_| ClaudeAiError::NotAuthenticated)?;
        return String::from_utf8(blob).map_err(|_| ClaudeAiError::NotAuthenticated);
    }
    #[cfg(not(target_os = "macos"))]
    Err(ClaudeAiError::NotAuthenticated)
}

/// Clear the stored cookie (sign-out).
pub fn clear_stored_cookie() -> Result<(), ClaudeAiError> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::delete_generic_password;
        let _ = delete_generic_password(SESSION_KEYCHAIN_SERVICE, "default");
    }
    Ok(())
}

/// Fetch claude.ai usage using the stored session cookie.
pub async fn fetch_claude_ai_usage(org_uuid: &str) -> Result<serde_json::Value, ClaudeAiError> {
    let cookie = read_stored_cookie()?;
    let url = format!("https://claude.ai/api/organizations/{}/usage", org_uuid);
    // Use the shared client from anthropic_oauth (same 10s timeout, same UA).
    let res = crate::anthropic_oauth::OAUTH_CLIENT
        .get(&url)
        .header("Cookie", format!("sessionKey={}", cookie))
        .header("Origin", "https://claude.ai")
        .header("Referer", "https://claude.ai/")
        .send()
        .await?;
    let status = res.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        // Cookie expired or invalidated — clear it so the UI can re-prompt.
        let _ = clear_stored_cookie();
        return Err(ClaudeAiError::NotAuthenticated);
    }
    if !status.is_success() {
        return Err(ClaudeAiError::Http(res.error_for_status().unwrap_err()));
    }
    Ok(res.json().await?)
}

#[cfg(test)]
mod retry_ceiling_tests {
    /// Pin the retry ceiling constant. If this changes, the manual smoke
    /// expectations (60s wall-clock before timeout event) need updating too.
    #[test]
    fn max_attempts_is_40() {
        assert_eq!(super::MAX_COOKIE_CAPTURE_ATTEMPTS, 40);
    }

    #[test]
    fn poll_interval_is_1500_ms() {
        assert_eq!(super::COOKIE_CAPTURE_POLL_MS, 1500);
    }

    /// 40 × 1.5s = 60s total before timeout.
    #[test]
    fn total_timeout_is_60s() {
        assert_eq!(
            super::MAX_COOKIE_CAPTURE_ATTEMPTS as u64 * super::COOKIE_CAPTURE_POLL_MS / 1000,
            60
        );
    }
}
