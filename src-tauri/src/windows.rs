//! Window construction helpers (popover + dashboard).
//!
//! Concrete `tauri::AppHandle` (= `AppHandle<Wry>`) — see tray.rs for rationale.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Build the menu-bar popover window (frameless, transparent, hidden at boot).
///
/// Idempotent: returns early if the window already exists. As of T17, the
/// popover is *no longer* declared in `tauri.conf.json` `app.windows[]` — this
/// function is now the single source of truth. Reason: a conf-declared window
/// is created by Tauri before `setup()` runs, which means the vibrancy
/// material applied here would never reach it (the early-return path would
/// short-circuit before the `apply_vibrancy` call). Dropping the conf entry
/// makes this function the canonical creator and ensures vibrancy is always
/// applied.
///
/// URL resolution note: `frontendDist` is set to `../popover` so embedded
/// assets are rooted at the popover/ directory. `WebviewUrl::App("index.html")`
/// resolves to `tauri://localhost/index.html` which Tauri serves from the
/// embedded `popover/index.html`. Using the bare `"index.html"` path triggers
/// Tauri's special-case in manager/webview.rs:452 that loads the asset root
/// directly without a Url::join hop.
///
/// NOTE: frontendDist (in tauri.conf.json) is rooted at "../popover" — Tauri's
/// asset embedding only includes files under frontendDist. The dashboard window
/// loads via WebviewUrl::External (HTTP from the SEA sidecar), independent of
/// frontendDist. Future windows wanting to load a bundled HTML asset must EITHER
/// place that asset under popover/ OR use WebviewUrl::External.
///
/// Vibrancy: on macOS, `NSVisualEffectMaterial::Popover` is applied with
/// `NSVisualEffectState::Active` (always-on, never dims with focus changes)
/// and a 14.0pt corner radius matching the popover's CSS border-radius
/// (popover/popover.css `#root { border-radius: 14px }`).
pub fn create_popover(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("popover").is_some() {
        return Ok(());
    }
    // v0.4.0: popover narrowed to 300px (was 380px) to match the new design's
    // denser layout. Height stays ample so the warning-state variant fits
    // comfortably without resizing the OS window — CSS just hides the
    // default-only sections.
    let win = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::App("index.html".into()),
    )
    .inner_size(300.0, 540.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        if let Err(e) = apply_vibrancy(
            &win,
            NSVisualEffectMaterial::Popover,
            Some(NSVisualEffectState::Active),
            Some(14.0), // matches popover.css #root border-radius (T16)
        ) {
            log::warn!("Failed to apply popover vibrancy: {}", e);
        }
    }

    if let Err(e) = win.hide() {
        log::warn!("Failed to hide popover after creation: {}", e);
    }
    Ok(())
}

/// Position the popover near the top-right of the active monitor (placeholder
/// approximation for tray-anchored positioning).
///
/// macOS does not expose tray icon coordinates through Tauri's public API
/// (NSStatusItem frame lookup requires Cocoa interop we haven't wired yet).
/// As a stopgap, we place the popover 16pt from the right edge and 32pt below
/// the menu bar (logical points, not physical pixels — see body comment) —
/// close enough to the menu bar tray icon to feel anchored, without
/// hard-coding the exact tray icon x-coordinate.
///
/// TODO(v0.3.0.x): Replace with actual tray-icon position via NSStatusItem
/// frame lookup once a Cocoa interop helper exists. The position should
/// nudge the popover so its top-center sits below the tray icon's center.
pub fn position_popover_under_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let popover = app
        .get_webview_window("popover")
        .ok_or(tauri::Error::WebviewNotFound)?;
    let Some(monitor) = popover.current_monitor()? else {
        log::debug!("Skipping popover positioning: no current monitor");
        return Ok(());
    };
    // Convert physical pixel sizes to logical points so the 16/32 constants
    // mean what they say on Retina (scale_factor 2.0). tao's
    // set_outer_position internally converts physical → logical, which would
    // halve our intended offsets and slide the popover under the menu bar
    // on every modern Mac. Using LogicalPosition skips that conversion.
    let scale = monitor.scale_factor();
    let monitor_logical = monitor.size().to_logical::<f64>(scale);
    let win_logical = popover.outer_size()?.to_logical::<f64>(scale);

    // Anchor near top-right of the menu bar (placeholder positioning).
    // 16pt clearance from the right edge, 32pt below the menu bar.
    let x = monitor_logical.width - win_logical.width - 16.0;
    let y = 32.0;

    popover.set_position(tauri::LogicalPosition::new(x, y))?;
    Ok(())
}

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
    let win = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(url.parse().unwrap()),
    )
    .title("Clauge")
    .inner_size(1480.0, 1100.0)
    .min_inner_size(900.0, 600.0)
    .resizable(true)
    .visible(true)
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
    .build()?;

    // Hide-on-close so reopens are instant (preserves window state + DOM).
    let win_handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(e) = win_handle.hide() {
                log::warn!("Failed to hide dashboard window on close: {}", e);
            }
        }
    });

    Ok(())
}
