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
    // of the `show-preferences` JS event once T17's popover wires it up.
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
                show_popover_with_preferences(app);
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

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let port = app_handle
                .try_state::<crate::ipc::AppState>()
                .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
            let Some(port) = port else { continue };
            let url = format!("http://127.0.0.1:{}/api/usage", port);
            match reqwest::get(&url).await {
                Ok(resp) => match resp.json::<serde_json::Value>().await {
                    Ok(json) => {
                        let pct = json
                            .get("plan")
                            .and_then(|p| p.get("fiveHour"))
                            .and_then(|f| f.get("pct"))
                            .and_then(|p| p.as_f64());
                        if let Some(pct) = pct {
                            if let Some(tray) = app_handle.tray_by_id("main") {
                                let title = format!(" {}%", pct.round() as i64);
                                if let Err(e) = tray.set_title(Some(&title)) {
                                    log::debug!("tray.set_title failed: {}", e);
                                }
                            }
                        }
                    }
                    Err(e) => log::debug!("usage json parse failed: {}", e),
                },
                Err(e) => log::debug!("usage fetch failed: {}", e),
            }
        }
    });

    Ok(())
}

fn show_dashboard(app: &AppHandle) {
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

fn toggle_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        match w.is_visible() {
            Ok(true) => {
                if let Err(e) = w.hide() {
                    log::warn!("Failed to hide popover: {}", e);
                }
            }
            _ => {
                // Position before showing so the popover appears in the right place.
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

fn show_popover_with_preferences(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        if let Err(e) = crate::windows::position_popover_under_tray(app) {
            log::warn!("Failed to position popover: {}", e);
        }
        if let Err(e) = w.show() {
            log::warn!("Failed to show popover: {}", e);
        }
        if let Err(e) = w.set_focus() {
            log::warn!("Failed to focus popover: {}", e);
        }
        if let Err(e) = w.eval("window.dispatchEvent(new CustomEvent('show-preferences'))") {
            log::warn!("Failed to dispatch show-preferences event: {}", e);
        }
    }
}
