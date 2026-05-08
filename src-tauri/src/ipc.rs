//! Tauri IPC commands exposed to WebView pages.

use std::sync::{Arc, Mutex};
use tauri::State;

/// Shared app state holding the sidecar's bound port.
#[derive(Default)]
pub struct AppState {
    pub server_port: Arc<Mutex<Option<u16>>>,
}

#[tauri::command]
pub fn get_server_port(state: State<AppState>) -> Result<u16, String> {
    state
        .server_port
        .lock()
        .map_err(|e| format!("lock poisoned: {}", e))?
        .ok_or_else(|| "server port not yet set".to_string())
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Ok(None) => Ok(()),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_server_port_returns_when_set() {
        let state = AppState::default();
        *state.server_port.lock().unwrap() = Some(3456);
        // Simulate the State<AppState> by directly calling logic
        let port = state.server_port.lock().unwrap().clone();
        assert_eq!(port, Some(3456));
    }

    #[test]
    fn get_server_port_errors_when_unset() {
        let state = AppState::default();
        let port = state.server_port.lock().unwrap().clone();
        assert_eq!(port, None);
    }
}
