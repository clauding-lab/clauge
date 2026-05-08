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
    // v0.4.0 fixup (T39): popover sized to 300×440 — the previous 300×540
    // had a ~150px transparent dead zone below content in the default state
    // (real content stack tops out near 390px). The default and warning
    // states now share a single fixed surface; CSS just hides the
    // irrelevant sections — see popover.css `data-state` selectors.
    //
    // 440px = default-state real content (~395px after restoring the
    // 5-ring layout with Opus) + ~45px tasteful breathing room. The
    // warn-state body is shorter (~250px) so it shows ~150px of glass
    // surface below the suggestion — visually intentional rather than
    // a dead zone, because the popover's `data-state="warn"` selector
    // tints the glass amber. Dynamic resize via `appWindow.setSize`
    // on state-flip would tighten warn further, but the user-visible
    // win is small relative to the added complexity.
    //
    // History: v0.3.x ran 380×540 (looser content). v0.4.0 narrowed to
    // 300px for the denser redesign but kept the original 540 height,
    // which created the dead zone. The warn-state CSS `width: 240px`
    // rule has also been removed (it produced a 60px gap on the right
    // when the OS window stayed at 300px).
    let win = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::App("index.html".into()),
    )
    .inner_size(300.0, 440.0)
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

/// Position the popover centered horizontally under the tray icon, 6pt below
/// its bottom edge. Falls back to top-right of the active monitor if
/// `TrayIcon::rect()` returns None (cold start before `tray::init` or a
/// removed NSStatusItem).
///
/// Multi-monitor caveat: clamp uses the popover's current monitor, not the
/// monitor containing the tray icon. On extended displays the popover may
/// land off-screen if the tray sits on a secondary monitor whose bounds
/// don't overlap the popover's. Tracked for v0.4.4.
pub fn position_popover_under_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let popover = app
        .get_webview_window("popover")
        .ok_or(tauri::Error::WebviewNotFound)?;
    let Some(monitor) = popover.current_monitor()? else {
        log::debug!("Skipping popover positioning: no current monitor");
        return Ok(());
    };
    // Math stays in logical points: tao's set_outer_position halves physical
    // offsets on Retina, so Logical values keep gaps/clamps interpretable.
    let scale = monitor.scale_factor();
    let monitor_logical = monitor.size().to_logical::<f64>(scale);
    let win_logical = popover.outer_size()?.to_logical::<f64>(scale);

    let (x, y) = match app.tray_by_id("main").and_then(|t| t.rect().ok().flatten()) {
        Some(rect) => {
            let tray_pos = rect.position.to_logical::<f64>(scale);
            let tray_size = rect.size.to_logical::<f64>(scale);
            let raw_x = tray_pos.x + tray_size.width / 2.0 - win_logical.width / 2.0;
            let raw_y = tray_pos.y + tray_size.height + 6.0;
            // 8pt screen-edge margin; degenerate (negative-width) bound
            // collapses to the lower bound — popover pinned at x=8.
            let clamped_x = raw_x
                .max(8.0)
                .min((monitor_logical.width - win_logical.width - 8.0).max(8.0));
            (clamped_x, raw_y)
        }
        None => {
            log::warn!("Tray rect unavailable; falling back to corner positioning");
            (monitor_logical.width - win_logical.width - 16.0, 32.0)
        }
    };

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
