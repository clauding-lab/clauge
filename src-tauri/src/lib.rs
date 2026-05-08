mod ipc;
mod port_discovery;
mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
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
        .invoke_handler(tauri::generate_handler![
            ipc::get_server_port,
            ipc::check_for_updates,
            ipc::set_autostart,
            ipc::get_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
