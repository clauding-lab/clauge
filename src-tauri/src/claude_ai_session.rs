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
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            if app_for_poll.get_webview_window(AUTH_WINDOW_LABEL).is_none() {
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
    // TODO(v0.8.0): replace with shared timeout-configured client.
    // reqwest::Client::new() has no default timeout — a slow claude.ai
    // response would hang the connections refresh.
    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .header("Cookie", format!("sessionKey={}", cookie))
        .header("Origin", "https://claude.ai")
        .header("Referer", "https://claude.ai/")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        )
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
