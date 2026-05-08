mod ipc;
mod port_discovery;
mod sidecar;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // Focus an existing window when a second launch is attempted.
            // Picks "any" window via .values().next() — acceptable until T13/T14
            // give the popover/main split deterministic identity.
            if let Some(w) = app.webview_windows().values().next() {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // TODO(T18): configure store path/migration when popover settings handler lands.
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ipc::AppState::default())
        .setup(|app| {
            // Cold-start: discover an external clauge-server first; fall back to
            // spawning + supervising our sidecar binary. Runs in a detached async
            // task so the WebView UI thread is unblocked.
            //
            // Race note: AppState's port may briefly be None while discover/spawn
            // settles. Frontend (popover, T17+) will need to poll get_server_port
            // until a value lands.
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match port_discovery::discover().await {
                    port_discovery::DiscoveryResult::External(port) => {
                        log::info!("Using external clauge server on port {}", port);
                        if let Some(state) = app_handle.try_state::<ipc::AppState>() {
                            if let Err(e) = state.set_port(port) {
                                log::error!("Failed to record external server port: {}", e);
                            }
                        }
                    }
                    port_discovery::DiscoveryResult::SpawnAt(_start) => {
                        sidecar::spawn_and_supervise(app_handle).await;
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::get_server_port,
            ipc::check_for_updates,
            ipc::set_autostart,
            ipc::get_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
