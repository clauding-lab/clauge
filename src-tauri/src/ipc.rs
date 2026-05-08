//! Tauri IPC commands exposed to WebView pages.

use std::sync::{Arc, Mutex};
use tauri::State;
use tokio::sync::Notify;

/// Shared app state holding the sidecar's bound port and shutdown signal.
///
/// `shutdown` is notified from the `RunEvent::ExitRequested` hook in `lib.rs`
/// so the sidecar supervisor can break out of its loop and explicitly kill the
/// running child (`CommandChild` has no `Drop`, so dropping the binding alone
/// would leak the OS process).
pub struct AppState {
    pub server_port: Arc<Mutex<Option<u16>>>,
    pub shutdown: Arc<Notify>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            server_port: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(Notify::new()),
        }
    }
}

impl AppState {
    /// Set the bound sidecar port. Used by sidecar startup once the server reports ready.
    pub fn set_port(&self, port: u16) -> Result<(), String> {
        let mut guard = self
            .server_port
            .lock()
            .map_err(|e| format!("lock poisoned: {}", e))?;
        *guard = Some(port);
        Ok(())
    }
}

/// Core read logic shared by the IPC command and its tests.
///
/// Tests exercise this directly so the lock-error mapping and `ok_or_else` chain
/// are covered. The `let guard = ...` binding makes the deref explicit and
/// survives a future change to a non-Copy port type.
fn read_port(state: &AppState) -> Result<u16, String> {
    let guard = state
        .server_port
        .lock()
        .map_err(|e| format!("lock poisoned: {}", e))?;
    guard.ok_or_else(|| "server port not yet set".to_string())
}

#[tauri::command]
pub fn get_server_port(state: State<AppState>) -> Result<u16, String> {
    read_port(&state)
}

/// Outcome of `check_for_updates`. Serialized as `"up_to_date"` or `"installed"`
/// for the frontend to distinguish "nothing to do" from "restart pending".
#[derive(serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateStatus {
    UpToDate,
    Installed,
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            Ok(UpdateStatus::Installed)
        }
        Ok(None) => Ok(UpdateStatus::UpToDate),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Show the dashboard window (creating it if it doesn't exist yet).
///
/// Concrete `tauri::AppHandle` (not the generic `<R: tauri::Runtime>` form
/// from the plan draft) so the signature matches the other IPC commands in
/// this file — Tauri's invoke_handler! generates uniform glue when all
/// handlers use the same handle type.
#[tauri::command]
pub async fn open_dashboard(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    } else {
        crate::windows::create_dashboard(&app).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_server_port_returns_when_set() {
        let state = AppState::default();
        *state.server_port.lock().unwrap() = Some(3456);
        assert_eq!(read_port(&state), Ok(3456));
    }

    #[test]
    fn get_server_port_errors_when_unset() {
        let state = AppState::default();
        let err = read_port(&state).unwrap_err();
        assert!(err.contains("not yet set"));
    }
}
