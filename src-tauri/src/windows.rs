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

    // v0.8.1: initial URL is the bundled splash. The splash JS listens for
    // the `sidecar-ready` Tauri event (emitted from sidecar.rs once the
    // sidecar binds + responds 200 to /api/health) and navigates the
    // webview to http://127.0.0.1:<port>/ — eliminating the cold-launch
    // "page not loaded" flash users saw on Windows in v0.8.0.
    let url = "splash.html";

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
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
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
            // v0.8.1: bundled splash via WebviewUrl::App. Tauri 2's actual URL
            // varies by platform:
            //   macOS / Linux: tauri://localhost/<file>
            //   Windows:       http://tauri.localhost/<file>
            //                  (WebView2 doesn't allow custom protocol schemes,
            //                  so Tauri uses a subdomain of localhost instead.)
            // Allow both shapes so the splash → dashboard transition works on
            // every platform. Plus the existing http://127.0.0.1:<port> /
            // http://localhost:<port> allow-list for the sidecar's dashboard,
            // with port read live from AppState so crash-respawned sidecars on
            // fallback ports don't lock the dashboard out.
            let host = u.host_str();
            if u.scheme() == "tauri" && matches!(host, Some("localhost")) {
                return true;
            }
            if matches!(host, Some("tauri.localhost")) && matches!(u.scheme(), "http" | "https") {
                return true;
            }
            let live_port = app_for_handler
                .try_state::<crate::ipc::AppState>()
                .and_then(|s| s.server_port.lock().ok().and_then(|g| *g))
                .unwrap_or(3456);
            let host_ok = matches!(host, Some("127.0.0.1") | Some("localhost"));
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
            // TODO(deprecation): migrate to tauri-plugin-opener when bumping Tauri.
            // shell.open is #[deprecated(since = "2.1.0")]. Adding the dependency
            // requires VISION.md sign-off.
            #[allow(deprecated)]
            let open_result = app_for_open.shell().open(url_str.clone(), None);
            if let Err(e) = open_result {
                log::warn!("Failed to open external link {}: {}", url_str, e);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()?;

    // Hide-on-close (macOS) vs let-OS-close (Windows). On macOS the menu-bar
    // popover keeps the app resident, so we hide instead of close to make
    // reopens instant (preserves window state + DOM). On Windows there is no
    // menu-bar surface; closing the window must quit the app (otherwise the
    // user has no way to relaunch).
    #[cfg(target_os = "macos")]
    {
        let win_handle = win.clone();
        let app_handle_for_close = app.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(e) = win_handle.hide() {
                    log::warn!("Failed to hide dashboard window on close: {}", e);
                }
                if let Err(e) =
                    app_handle_for_close.set_activation_policy(tauri::ActivationPolicy::Accessory)
                {
                    log::warn!(
                        "Failed to set activation policy to Accessory on close: {}",
                        e
                    );
                }
            }
        });
    }
    // On non-macOS targets we install no close handler — Tauri's default
    // behavior (let the OS close the window; auto-quit when the last window
    // closes) is what we want. The existing RunEvent::ExitRequested handler
    // in lib.rs::run drains the sidecar children on quit.

    Ok(())
}
