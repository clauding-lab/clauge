//! Window construction helpers (popover + dashboard).
//!
//! Concrete `tauri::AppHandle` (= `AppHandle<Wry>`) — see tray.rs for rationale.
//! Task 14 will fill in real `WebviewWindowBuilder` calls.

use tauri::AppHandle;

pub fn create_popover(_app: &AppHandle) -> tauri::Result<()> {
    // TODO Task 14
    Ok(())
}

pub fn create_dashboard(_app: &AppHandle) -> tauri::Result<()> {
    // TODO Task 14
    Ok(())
}
