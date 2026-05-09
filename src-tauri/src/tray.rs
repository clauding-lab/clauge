//! Dashboard window helpers (formerly the Tauri tray module).
//!
//! v0.5.0: the Tauri `TrayIconBuilder` tray + WebviewWindow popover were
//! deleted in favor of `native_popover.rs` (NSStatusItem + NSPopover). What
//! remains here are two helpers that show the dashboard window — both are
//! still called from native_popover's NSMenu actions and from
//! `lib.rs::on_menu_event` (`menu:preferences`).
//!
//! Concrete `tauri::AppHandle` (= `AppHandle<Wry>`) for parity with ipc.rs's
//! concrete-runtime `#[tauri::command]` glue.

use tauri::{AppHandle, Manager};

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
/// "Preferences…" entry point (App menu, native popover menu, Cmd+,) —
/// preferences now live as a sub-section in the dashboard's existing Settings
/// tab. The `show-settings` CustomEvent is consumed by public/app.js.
pub fn show_dashboard_with_settings(app: &AppHandle) {
    show_dashboard(app);
    if let Some(w) = app.get_webview_window("main") {
        if let Err(e) = w.eval("window.dispatchEvent(new CustomEvent('show-settings'))") {
            log::warn!("Failed to dispatch show-settings event: {}", e);
        }
    }
}
