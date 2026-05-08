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
    let open_dashboard = MenuItem::with_id(
        app, "open_dashboard", "Open Dashboard", true, None::<&str>,
    )?;
    let preferences = MenuItem::with_id(
        app, "preferences", "Preferences…", true, Some("Cmd+,"),
    )?;
    let check_updates = MenuItem::with_id(
        app, "check_updates", "Check for Updates", true, None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Clauge", true, Some("Cmd+Q"))?;

    let menu = Menu::with_items(
        app,
        &[&open_dashboard, &preferences, &check_updates, &separator, &quit],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "open_dashboard" => {
                show_dashboard(app);
            }
            "preferences" => {
                show_popover_with_preferences(app);
            }
            "check_updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::ipc::check_for_updates(app).await;
                });
            }
            "quit" => {
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

    Ok(())
}

fn show_dashboard(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        crate::windows::create_dashboard(app).ok();
    }
}

fn toggle_popover(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        match w.is_visible() {
            Ok(true) => { let _ = w.hide(); }
            _ => {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    }
}

fn show_popover_with_preferences(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("popover") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval("window.dispatchEvent(new CustomEvent('show-preferences'))");
    }
}
