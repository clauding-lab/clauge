mod ipc;
mod menu;
mod native_popover;
mod port_discovery;
mod sidecar;
mod tray;
mod windows;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize the `log` crate backend; without this every log::* call
    // throughout this crate is silently dropped. `try_init` is no-panic
    // on re-entry (tests, harnesses).
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second-launch attempt (spec §6.7): prefer focusing the popover
            // (the primary glanceable surface). If popover doesn't exist
            // (degraded startup — see windows.rs::create_popover), fall back
            // to the dashboard window. If neither exists, log and bail —
            // duplicate launches must never spawn a second app instance.
            if let Some(popover) = app.get_webview_window("popover") {
                if let Err(e) = crate::windows::position_popover_under_tray(app) {
                    log::warn!("Failed to position popover on second-launch: {}", e);
                }
                if let Err(e) = popover.show() {
                    log::warn!("Failed to show popover on second-launch: {}", e);
                }
                if let Err(e) = popover.set_focus() {
                    log::warn!("Failed to focus popover on second-launch: {}", e);
                }
            } else if let Some(main) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                {
                    if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
                        log::warn!(
                            "Failed to set activation policy to Regular on second-launch: {}",
                            e
                        );
                    }
                }
                if let Err(e) = main.show() {
                    log::warn!("Failed to show dashboard on second-launch: {}", e);
                }
                if let Err(e) = main.set_focus() {
                    log::warn!("Failed to focus dashboard on second-launch: {}", e);
                }
            } else {
                log::warn!("Second-launch attempt found neither popover nor dashboard window");
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        // Filter excludes the popover from state tracking — popover is a
        // fixed-size menu-bar surface (300×440 per windows.rs). If tracked,
        // any stale resize gets persisted across launches as a "ghost outline"
        // (the OS window keeps the cached size while CSS content fills only
        // the configured area). Dashboard ("main") still tracks normally.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label != "popover")
                .build(),
        )
        // TODO(T18): configure store path/migration when popover settings handler lands.
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ipc::AppState::default())
        .setup(|app| {
            // Boot as menu-bar-only (no Dock icon, not in Cmd+Tab). The dock
            // icon flips ON when the dashboard window opens (tray.rs::show_dashboard
            // and ipc::open_dashboard) and OFF again when the dashboard closes
            // (windows.rs::create_dashboard window-close handler).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Build the popover FIRST so tray/menu handlers (and Cmd+,) always
            // have a window to show, even if subsequent setup steps fail.
            // T17 dropped the conf.json windows[] entry, so this is the single
            // source of truth for popover creation.
            crate::windows::create_popover(app.handle())?;

            crate::tray::init(app.handle())?;

            // Native macOS app-wide menu (Clauge / Edit / View / Window / Help).
            // Custom ids (`menu:preferences`, `menu:refresh`, `menu:github`)
            // are dispatched below; predefined items (Quit, Hide,
            // Cut/Copy/Paste, Minimize…) are handled natively by Tauri/muda.
            // Ids carry a `menu:` prefix to disambiguate from tray.rs's
            // `tray:` ids — see menu.rs module doc for why namespacing is
            // required (Tauri menu event listeners are global).
            let menu = crate::menu::build(app.handle())?;
            app.set_menu(menu)?;
            // First-launch autostart enablement (spec §3 Decision #8 + §4.2:
            // "Launch at Login (default ON)"; toggle-OFF flow lives in §6.6).
            // Placed AFTER menu setup so menu/tray remain functional even if
            // the store fails to open. The store carries a `first_launch_done`
            // flag in settings.json (~/Library/Application Support/com.clauding.clauge/settings.json).
            // If the flag is absent (fresh install OR user wiped settings), we
            // call `app.autolaunch().enable()` to register Clauge in macOS
            // Login Items, then mark the flag so subsequent launches no-op.
            // The user can later toggle autostart OFF via the popover gear
            // (spec §6.6); we do not re-enable it once they've opted out.
            {
                use tauri_plugin_autostart::ManagerExt;
                use tauri_plugin_store::StoreExt;

                let store = app.store("settings.json").map_err(|e| {
                    log::error!("Failed to open settings store: {}", e);
                    e
                })?;

                if store.get("first_launch_done").is_none() {
                    log::info!("First launch detected; enabling Launch at Login by default");
                    if let Err(e) = app.autolaunch().enable() {
                        log::warn!("Failed to enable autostart on first launch: {}", e);
                    }
                    store.set("first_launch_done", serde_json::Value::Bool(true));
                    if let Err(e) = store.save() {
                        log::warn!("Failed to persist first_launch_done flag: {}", e);
                    }
                }
            }

            app.on_menu_event(|app, event| match event.id().0.as_str() {
                "menu:preferences" => {
                    crate::tray::show_dashboard_with_settings(app);
                }
                "menu:refresh" => {
                    if let Some(w) = app.get_webview_window("main") {
                        if let Err(e) = w.eval("location.reload()") {
                            log::warn!("Failed to reload dashboard: {}", e);
                        }
                    }
                }
                "menu:github" => {
                    use tauri_plugin_shell::ShellExt;
                    // Rust-side shell.open() bypasses scope validation
                    // (tauri-plugin-shell open.rs:131), so no
                    // `shell:allow-open` capability is required for this call.
                    // TODO(deprecation): migrate to tauri-plugin-opener when
                    // bumping Tauri. shell.open is #[deprecated(since = "2.1.0")].
                    if let Err(e) = app
                        .shell()
                        .open("https://github.com/clauding-lab/clauge", None)
                    {
                        log::warn!("Failed to open GitHub repository: {}", e);
                    }
                }
                _ => {}
            });

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
                        // TODO(spec §6.2): External branch is one-shot. If the
                        // external clauge dies, V3 stays pointed at a dead port.
                        // Add periodic re-probe + fall back to spawn_and_supervise.
                        // Tracked as deferred work.
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

            let app_handle_updater = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::ipc::check_for_updates(app_handle_updater).await {
                    log::warn!("Updater check on launch failed: {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::get_server_port,
            ipc::check_for_updates,
            ipc::set_autostart,
            ipc::get_autostart,
            ipc::open_dashboard,
            ipc::quit_app,
            ipc::proxy_fetch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Honor spec §6.7 quit flow. v0.3.1 hardened against orphan sidecars
        // (Bug #1 in v0.3.0 smoke testing — clauge-server PIDs accumulated
        // across launches because the supervisor's `notify_waiters()` was
        // either lost edge-triggered OR couldn't see crash-respawned children).
        //
        // The fix has TWO halves:
        //
        //  1. SUPERVISOR-DRIVEN (preferred): set the shutting_down flag AND
        //     fire notify_waiters. The supervisor loop in sidecar.rs polls the
        //     flag between phases, so even a quit during backoff or mid-spawn
        //     gets observed. If it's currently awaiting `notified()`, the
        //     notify wakes it through immediately.
        //
        //  2. PARENT-DRIVEN (belt-and-braces): seize all currently-registered
        //     children from AppState::children and explicitly kill each one.
        //     This catches the case where a fresh child was spawned by the
        //     crash circuit-breaker AFTER the user clicked Quit — the
        //     supervisor's level-triggered guard would have stopped it on the
        //     next iteration, but in the meantime a child OS process exists.
        //     CommandChild has no Drop, so this kill is the only way to
        //     guarantee the OS process exits with the parent.
        if let tauri::RunEvent::ExitRequested { .. } = event {
            if let Some(state) = app_handle.try_state::<ipc::AppState>() {
                log::info!("Exit requested; tearing down sidecar children");
                state.signal_shutdown();

                // Drain the child registry and kill each one. We do this on
                // the OS thread (not via async_runtime::spawn) because the
                // tokio runtime is already winding down — a spawned async task
                // here might never get scheduled before the process exits.
                // CommandChild::kill is a sync function (it shells out to
                // SharedChild::kill which calls libc::kill), so this is fine.
                let children = state.take_all_children();
                let count = children.len();
                if count > 0 {
                    log::info!("Killing {} sidecar child process(es) on quit", count);
                }
                for child in children {
                    let pid = child.pid();
                    if let Err(e) = child.kill() {
                        log::warn!("Failed to kill sidecar pid={}: {}", pid, e);
                    } else {
                        log::info!("Killed sidecar pid={}", pid);
                    }
                }

                // Brief grace window: lets the supervisor's `notified()`
                // observer return cleanly AND gives `kill()` time to deliver
                // SIGKILL before the runtime tears everything down. 200ms is
                // empirically enough on macOS without making quit feel sluggish
                // — most of the work above is synchronous already.
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    });
}
