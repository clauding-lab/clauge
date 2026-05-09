//! Tray icon + native right-click menu.
//!
//! Note: this module uses the concrete `tauri::AppHandle` (= `AppHandle<Wry>`)
//! rather than a generic `AppHandle<R: Runtime>` because the IPC layer
//! (`crate::ipc::check_for_updates`) is wired to the concrete runtime as a
//! `#[tauri::command]`. The plan sketched a generic signature, but the menu
//! event handler can't bridge generic `R` and concrete `Wry` for the IPC call,
//! so we mirror ipc.rs's concrete pattern.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    // Menu item ids are namespaced with `tray:` so they don't collide with
    // the app menu's `menu:` ids. Tauri's menu event listeners are global
    // (tray.on_menu_event and app.on_menu_event both push into the same
    // app_handle.manager.menu.global_event_listeners vec), so EVERY listener
    // fires for EVERY menu event regardless of source. Without namespacing,
    // a click on the app menu's "Preferences…" would also fire this tray
    // handler's "preferences" arm (and vice versa), causing dual-dispatch
    // of the `show-settings` JS event toward the dashboard webview.
    let open_dashboard = MenuItem::with_id(
        app, "tray:open_dashboard", "Open Dashboard", true, None::<&str>,
    )?;
    let preferences = MenuItem::with_id(
        app, "tray:preferences", "Preferences…", true, Some("Cmd+,"),
    )?;
    let check_updates = MenuItem::with_id(
        app, "tray:check_updates", "Check for Updates", true, None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray:quit", "Quit Clauge", true, Some("Cmd+Q"))?;

    let menu = Menu::with_items(
        app,
        &[&open_dashboard, &preferences, &check_updates, &separator, &quit],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray-icon.png"
        ))?)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "tray:open_dashboard" => {
                show_dashboard(app);
            }
            "tray:preferences" => {
                show_dashboard_with_settings(app);
            }
            "tray:check_updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::ipc::check_for_updates(app).await {
                        log::warn!("Failed to check for updates: {}", e);
                    }
                });
            }
            "tray:quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event {
                if matches!(button, MouseButton::Left) {
                    toggle_popover(tray.app_handle());
                }
            }
        })
        .build(app)?;

    // Note: the 30s /api/usage poll that writes the % chiclet to the tray
    // title moved to native_popover.rs::spawn_tray_title_poller in v0.5.0
    // so it updates the new NSStatusItem.button.title rather than the (about
    // to be deleted) Tauri tray.

    Ok(())
}

pub fn show_dashboard(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            log::warn!("Failed to set activation policy to Regular: {}", e);
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = w.show() {
            log::warn!("Failed to show dashboard: {}", e);
        }
        if let Err(e) = w.set_focus() {
            log::warn!("Failed to focus dashboard: {}", e);
        }
    } else if let Err(e) = crate::windows::create_dashboard(app) {
        log::warn!("Failed to create dashboard: {}", e);
    }
}

/// Open the dashboard and switch it to the Settings tab. Used by every former
/// "Preferences…" entry point (App menu, tray menu, Cmd+,) — preferences now
/// live as a sub-section in the dashboard's existing Settings tab. The
/// `show-settings` CustomEvent is consumed by public/app.js.
pub fn show_dashboard_with_settings(app: &AppHandle) {
    show_dashboard(app);
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = w.eval("window.dispatchEvent(new CustomEvent('show-settings'))") {
            log::warn!("Failed to dispatch show-settings event: {}", e);
        }
    }
}

fn toggle_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        let state = app.try_state::<crate::ipc::AppState>();
        match w.is_visible() {
            Ok(true) => {
                // User-initiated dismiss — clear intent before hide so the
                // create_popover focus-loss handler doesn't immediately re-show.
                if let Some(s) = &state {
                    s.popover_user_visible
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                }
                if let Err(e) = w.hide() {
                    log::warn!("Failed to hide popover: {}", e);
                }
            }
            _ => {
                if let Some(s) = &state {
                    s.popover_user_visible
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                }
                if let Err(e) = crate::windows::position_popover_under_tray(app) {
                    log::warn!("Failed to position popover: {}", e);
                }
                if let Err(e) = w.show() {
                    log::warn!("Failed to show popover: {}", e);
                }
                if let Err(e) = w.set_focus() {
                    log::warn!("Failed to focus popover: {}", e);
                }
            }
        }
    }
}
