pub mod anthropic_oauth;
mod claude_ai_session;
pub mod connections;
mod ipc;
mod keychain;
mod keychain_cache;
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
            // Second-launch attempt (spec §6.7): show the dashboard. The
            // native popover is an NSPopover (not a Tauri WebviewWindow), so
            // the single-instance plugin can't introspect or focus it from
            // here — the dashboard is the next-best glanceable surface.
            crate::tray::show_dashboard(app);
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
            // macOS: boot as menu-bar-only (no Dock icon, not in Cmd+Tab). The
            // dock icon flips ON when the dashboard window opens (tray.rs::show_dashboard
            // and ipc::open_dashboard) and OFF again when the dashboard closes
            // (windows.rs::create_dashboard window-close handler). The native
            // popover (NSStatusItem + NSPopover) is the always-visible % chiclet.
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                crate::native_popover::init(app.handle())?;
            }

            // Windows (and any non-macOS target): there is no menu-bar surface;
            // the dashboard window IS the app. Open it on launch. Phase 1 Task 2
            // will cfg-gate windows.rs's prevent_close+hide so closing the dashboard
            // on Windows actually quits the app (today's close handler is
            // unconditional and would leave the app as an invisible background
            // process on Windows).
            #[cfg(not(target_os = "macos"))]
            {
                crate::tray::show_dashboard(app.handle());
            }

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

            // v0.7.2: first-launch onboarding wizard. Gated by a SEPARATE flag
            // (`onboarding_completed`) so a future "Re-run setup" feature can
            // reset it without flipping the autostart flag.
            // The wizard window is spawned even before sidecar port discovery
            // completes — the URL it loads uses port 3456 (the default sidecar
            // bind) which the port_discovery::SpawnAt branch reserves. If the
            // user has an external clauge-server on a non-default port, the
            // wizard's URL would fall through to a 404; for v0.7.2 we accept
            // this edge case since external-clauge-server users are typically
            // power users who've already onboarded.
            {
                use tauri_plugin_store::StoreExt;
                let store = app.store("settings.json").map_err(|e| {
                    log::error!("Failed to open settings store: {}", e);
                    e
                })?;
                if store.get("onboarding_completed").is_none() {
                    log::info!("First-launch wizard not yet completed; spawning onboarding window");
                    let app_handle = app.handle().clone();
                    // Spawn into the async runtime so we don't block setup.
                    // The wizard window uses URL http://127.0.0.1:3456/onboarding/index.html
                    // which will be available once the sidecar starts (the spawn
                    // below races with port_discovery, but Tauri's WebviewWindow
                    // handles a temporarily-404 load gracefully by retrying when
                    // the user clicks).
                    tauri::async_runtime::spawn(async move {
                        // Brief delay so port_discovery has a chance to bind.
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        let url = tauri::WebviewUrl::External(
                            "http://127.0.0.1:3456/onboarding/index.html"
                                .parse()
                                .unwrap(),
                        );
                        let result =
                            tauri::WebviewWindowBuilder::new(&app_handle, "onboarding", url)
                                .title("Welcome to Clauge")
                                .inner_size(560.0, 640.0)
                                .resizable(false)
                                .center()
                                .visible(true)
                                .build();
                        if let Err(e) = result {
                            log::error!("Failed to spawn onboarding wizard window: {}", e);
                            // Mark the flag so we don't loop on a broken wizard.
                            if let Ok(store) = app_handle.store("settings.json") {
                                store.set("onboarding_completed", serde_json::Value::Bool(true));
                                let _ = store.save();
                            }
                        }
                    });
                } else {
                    log::debug!("Onboarding wizard already completed; skipping");
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
                            crate::native_popover::reload_for_port(&app_handle, port);
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
            ipc::open_claude_ai_login,
            ipc::signout_claude_ai,
            ipc::has_claude_ai_session,
            ipc::get_connection_status,
            ipc::refresh_credentials,
            ipc::wizard_complete,
            ipc::wizard_skip,
            ipc::restart_app,
            ipc::take_pending_focus_connections,
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
