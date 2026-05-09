//! Window construction helpers (dashboard).
//!
//! Concrete `tauri::AppHandle` (= `AppHandle<Wry>`) — see tray.rs for rationale.
//!
//! v0.5.0: the menu-bar popover moved to `native_popover.rs` (NSStatusItem +
//! NSPopover). The Tauri WebviewWindow popover (`create_popover` +
//! `position_popover_under_tray`) was deleted; only `create_dashboard` remains.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub fn create_dashboard(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Idempotent: if "main" window exists already, just return — caller (tray)
    // will handle .show() / .set_focus() on the existing window.
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }

    // Read the bound port from AppState; fall back to 3456 if absent or poisoned.
    // (Plan used `.lock().unwrap()` which panics on poison; `.ok().and_then(...)`
    // gracefully degrades to the default.)
    //
    // TODO(spec §6.1 race): If the user opens the dashboard before the
    // discover/spawn task has set AppState.server_port, this falls back to
    // 3456. That's correct for the common case (sidecar binds 3456), but
    // silently wrong if another app squatted on 3456 and the sidecar bound
    // 3457+. Spec §6.1 line 300 makes this recoverable via the dashboard's
    // 10s poll loop. Future mitigation: show a "Starting server…" splash
    // while port=None, or block dashboard creation until set_port fires.
    let port = app
        .try_state::<crate::ipc::AppState>()
        .and_then(|s| s.server_port.lock().ok().and_then(|g| *g))
        .unwrap_or(3456);
    let url = format!("http://127.0.0.1:{}/", port);

    // Defensive `on_navigation` handler (v0.3.1, Bug #3 follow-up).
    //
    // Bug #3's primary cause was the sidecar's auto-open (server.js:594) —
    // fixed by passing `NO_OPEN=1` in sidecar.rs. Without an on_navigation
    // handler, Tauri 2.x allows any navigation by default, which means a
    // stray same-window `location.href = "https://example.com"` in the
    // dashboard JS would navigate the dashboard webview AWAY from the API
    // server. Returning `true` only for the SEA server's host:port pins the
    // webview to its intended content.
    //
    // External links (`target="_blank"`) status: currently broken — and this
    // handler is NOT what fixes them. Verified against wry-0.55.1 and
    // tauri-runtime-wry-2.11.1: `target="_blank"` clicks route through
    // wry's new-window request handler (createWebViewForNavigationAction on
    // macOS), which Tauri only installs when `pending.new_window_handler`
    // is `Some`. We don't call `.on_new_window(...)` below, so that handler
    // is `None`, so the macOS WKWebView delegate returns `nil` and silently
    // drops the new window. Anchor clicks pointing at claude.ai / github.com
    // inside the install-extension panel are presently no-ops. This is a
    // pre-existing v0.3.0 issue — NOT caused by this on_navigation handler
    // — and is deferred to v0.3.2 (which will wire `.on_new_window(...)` to
    // shell-open external URLs).
    //
    // Port read: pulled live from AppState on EVERY navigation rather than
    // captured at dashboard creation. Sidecar crash-respawn (T30) can land
    // the new server on a fallback port (3457+) and update AppState; if we
    // captured the port here, the dashboard would refuse the redirect to
    // the new port and lock itself out of its own server.
    let app_for_handler = app.clone();
    let app_for_open = app.clone();
    let mut builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(url.parse().unwrap()),
    )
    .title("Clauge")
    .inner_size(1100.0, 800.0)
    .min_inner_size(900.0, 600.0)
    .resizable(true)
    .visible(true);

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }

    let win = builder
        .on_navigation(move |u| {
            // Allow our own SEA server (host MUST be 127.0.0.1 OR localhost,
            // port MUST match the bound port AT NAVIGATION TIME — read live
            // from AppState so crash-respawned sidecars on fallback ports
            // don't lock the dashboard out).
            let live_port = app_for_handler
                .try_state::<crate::ipc::AppState>()
                .and_then(|s| s.server_port.lock().ok().and_then(|g| *g))
                .unwrap_or(3456);
            let host_ok = matches!(u.host_str(), Some("127.0.0.1") | Some("localhost"));
            let port_ok = u.port_or_known_default() == Some(live_port);
            let scheme_ok = u.scheme() == "http";
            let allowed = host_ok && port_ok && scheme_ok;
            if !allowed {
                log::info!("Blocked dashboard navigation to {}", u);
            }
            allowed
        })
        .on_new_window(move |url, _features| {
            use tauri_plugin_shell::ShellExt;
            // Defense-in-depth: only http/https/mailto are forwarded to the OS
            // launcher. Without this, a future XSS in the dashboard could open
            // file://, javascript:, or custom URL handlers (slack://, zoommtg://)
            // through shell.open — which delegates straight to macOS open(1)
            // with no scheme validation.
            let scheme = url.scheme();
            if !matches!(scheme, "http" | "https" | "mailto") {
                log::warn!("Blocked external link with disallowed scheme: {}", url);
                return tauri::webview::NewWindowResponse::Deny;
            }
            let url_str = url.to_string();
            if let Err(e) = app_for_open.shell().open(url_str.clone(), None) {
                log::warn!("Failed to open external link {}: {}", url_str, e);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;

    // Hide-on-close so reopens are instant (preserves window state + DOM).
    let win_handle = win.clone();
    let app_handle_for_close = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(e) = win_handle.hide() {
                log::warn!("Failed to hide dashboard window on close: {}", e);
            }
            #[cfg(target_os = "macos")]
            {
                if let Err(e) = app_handle_for_close
                    .set_activation_policy(tauri::ActivationPolicy::Accessory)
                {
                    log::warn!(
                        "Failed to set activation policy to Accessory on close: {}",
                        e
                    );
                }
            }
        }
    });

    Ok(())
}
