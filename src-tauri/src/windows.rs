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
/// and a 12.0pt corner radius matching the popover's CSS border-radius.
pub fn create_popover(app: &tauri::AppHandle) -> tauri::Result<()> {
    if app.get_webview_window("popover").is_some() {
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::App("index.html".into()),
    )
    .inner_size(380.0, 600.0)
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
            Some(12.0),
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
/// As a stopgap, we place the popover 16px from the right edge and 32px below
/// the menu bar — close enough to the menu bar tray icon to feel anchored,
/// without hard-coding the exact tray icon x-coordinate.
///
/// TODO(v0.3.0.x): Replace with actual tray-icon position via NSStatusItem
/// frame lookup once a Cocoa interop helper exists. The position should
/// nudge the popover so its top-center sits below the tray icon's center.
pub fn position_popover_under_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let popover = app
        .get_webview_window("popover")
        .ok_or(tauri::Error::WebviewNotFound)?;
    let monitor = popover
        .current_monitor()?
        .ok_or(tauri::Error::WebviewNotFound)?;
    let monitor_size = monitor.size();
    let win_size = popover.outer_size()?;

    // Anchor near top-right of the menu bar (placeholder positioning).
    let x = (monitor_size.width as i32) - (win_size.width as i32) - 16;
    let y = 32;

    popover.set_position(tauri::PhysicalPosition::new(x, y))?;
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
