pub mod anthropic_oauth;
// v0.9.0 MAS (Task 12b): cfg-gate claude_ai_session on MAS. The module
// reads/writes a Keychain entry the non-sandboxed DMG wrote. The MAS sandbox
// identity doesn't auto-grant access, so the IPC polling path triggers a
// Keychain prompt every cycle. Clauge Sync browser extension is the MAS path.
#[cfg(not(feature = "mas"))]
mod claude_ai_session;
pub mod connections;
mod http_client;
mod ipc;
mod keychain;
mod keychain_cache;
mod menu;
mod native_popover;
mod port_discovery;
mod port_file;
// v0.9.0 MAS flavor only: NSURL security-scoped bookmark wrapper for the
// user-granted read access to ~/.claude/. DMG flavor reads the filesystem
// directly and does not compile this module.
#[cfg(feature = "mas")]
mod security_scoped_bookmark;
// v0.9.10 MAS flavor only: launch-at-login via Apple's SMAppService
// (sandbox-correct, macOS 13+). The DMG/Windows flavors use
// tauri-plugin-autostart (LaunchAgent) instead — see the builder chain.
#[cfg(feature = "mas")]
mod autostart_mas;
// Phase ②b: coordinated atomic write of the analytics snapshot into the app's
// iCloud Drive container (read by the companion iOS app). BOTH flavors publish:
// MAS resolves the container via NSFileManager::URLForUbiquityContainerIdentifier
// (sandbox-correct), the DMG resolves it by the direct unsandboxed path. Cocoa-
// based, so gated to macOS (must stay off Windows), not to the MAS feature.
#[cfg(target_os = "macos")]
mod icloud_writer;
// Phase ②b: drives the periodic publish of the analytics snapshot into the
// app's iCloud container (sibling to the sidecar supervisor). Both flavors.
#[cfg(target_os = "macos")]
mod icloud_publish;
mod sidecar;
// v1.2.0 Item 4: iCloud upload-confirmation health (sync-health). macOS-only
// (reads iCloud resource values via Cocoa); both flavors. Pure derivation is
// unit-tested; the native read runs behind icloud_publish's spawn_blocking.
#[cfg(target_os = "macos")]
mod sync_health;
mod tray;
mod windows;

use tauri::Manager;

/// v0.9.10 (Apple Issue 2 fix): build the first-launch onboarding WebviewWindow
/// at most once. The setup() block registers TWO ways to trigger this — a
/// `sidecar-ready` event listener AND a 30 s timeout fallback — and races
/// them via the `spawned` `AtomicBool`. Whichever fires first wins; the loser
/// observes `swap(true)` returning true and bails out.
///
/// Build failures here are logged but do NOT flip `onboarding_completed=true`
/// (the prior implementation did, which turned a transient build error into a
/// permanent dead state — see commit history and AGENT_LEARNINGS.md).
fn spawn_wizard_window_once(
    app: &tauri::AppHandle,
    port: u16,
    spawned: &std::sync::atomic::AtomicBool,
) {
    if spawned.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let url_str = format!("http://127.0.0.1:{}/onboarding/index.html", port);
    let url = match url_str.parse() {
        Ok(u) => tauri::WebviewUrl::External(u),
        Err(e) => {
            log::error!("Failed to parse wizard URL '{}': {}", url_str, e);
            return;
        }
    };
    let result = tauri::WebviewWindowBuilder::new(app, "onboarding", url)
        .title("Welcome to Clauge")
        .inner_size(560.0, 640.0)
        .resizable(false)
        .center()
        .visible(true)
        .build();
    if let Err(e) = result {
        // Intentionally NOT setting onboarding_completed=true here: a
        // transient build failure (resource race during cold launch, etc.)
        // should be retried on next launch, not turned into a permanent
        // "no-wizard-ever" state. The user's next launch goes through the
        // same code path and tries again.
        log::error!("Failed to spawn onboarding wizard window: {}", e);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize the `log` crate backend; without this every log::* call
    // throughout this crate is silently dropped. `try_init` is no-panic
    // on re-entry (tests, harnesses).
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    // v0.9.0 MAS flavor: the updater plugin is cfg-gated below so it is
    // ABSENT from MAS binaries (Apple App Store policy forbids in-app updates).
    // The cfg attribute can't gate a single `.plugin(...)` mid-chain in a
    // fluent builder expression, so we split the chain into a let-binding,
    // conditionally rebind it with the updater plugin attached for non-MAS
    // builds, then continue the chain. tauri.mas.conf.json also sets
    // `plugins.updater: null` (belt + suspenders).
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Second-launch attempt (spec §6.7): show the dashboard. The
            // native popover is an NSPopover (not a Tauri WebviewWindow), so
            // the single-instance plugin can't introspect or focus it from
            // here — the dashboard is the next-best glanceable surface.
            crate::tray::show_dashboard(app);
        }));

    // Launch-at-login plugin (LaunchAgent) is for the NON-sandboxed flavors only.
    // Under the MAS App Sandbox a LaunchAgent plist write is redirected into the
    // app container where launchd never scans it, so autostart silently fails AND
    // the wizard's "added to login items" claim would be false. MAS uses Apple's
    // sandbox-correct SMAppService instead (crate::autostart_mas), wired into the
    // set_autostart/get_autostart IPCs and the first-launch enable below.
    #[cfg(not(feature = "mas"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));

    #[cfg(not(feature = "mas"))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    let app = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        // TODO(T18): configure store path/migration when popover settings handler lands.
        .plugin(tauri_plugin_store::Builder::default().build())
        // v0.9.0: dialog plugin is consumed by the MAS-flavor
        // security-scoped bookmark module to present NSOpenPanel for the
        // user-granted ~/.claude/ read access. Registered unconditionally
        // because the cost is dormant on DMG (no code calls into it) and
        // ACL on main.json gates any frontend access (none granted).
        .plugin(tauri_plugin_dialog::init())
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
            // First-launch autostart enablement — DMG/Windows ONLY.
            //
            // DMG/NSIS builds register Clauge as a login item on first launch
            // (LaunchAgent via tauri-plugin-autostart), tracked by a
            // `first_launch_done` flag in settings.json so it runs exactly once.
            // The user can toggle it OFF later (dashboard/popover) or in the OS.
            //
            // MAS deliberately does NOT auto-register. Apple Guideline
            // 2.4.5(iii) forbids auto-launching at login without explicit user
            // consent (Clauge v0.9.10 build 4 was rejected for exactly this).
            // On MAS, Launch at Login is strictly OPT-IN: the onboarding wizard
            // (Step 3) and the dashboard/popover toggles call `set_autostart`
            // (→ crate::autostart_mas / SMAppService) ONLY when the user
            // explicitly enables it. See AGENTS.md landmine #28.
            #[cfg(not(feature = "mas"))]
            {
                use tauri_plugin_store::StoreExt;

                let store = app.store("settings.json").map_err(|e| {
                    log::error!("Failed to open settings store: {}", e);
                    e
                })?;

                if store.get("first_launch_done").is_none() {
                    log::info!("First launch detected; enabling Launch at Login by default (non-MAS)");

                    use tauri_plugin_autostart::ManagerExt;
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
            //
            // v0.9.10 (Apple Issue 2 fix): the wizard window URL points at
            // the sidecar's HTTP server (http://127.0.0.1:PORT/onboarding/...).
            // The sidecar takes 1–8 s to bind on cold launch in sandbox
            // (loadPriceTable HTTP fetch + serveStatic setup + listenWithRetry).
            // The prior implementation opened the wizard at T+500ms with no
            // listener for sidecar-ready → webview showed ERR_CONNECTION_REFUSED
            // → reviewer saw a blank "Welcome to Clauge" window → Apple
            // rejected under Guideline 2.1(a).
            //
            // Fix: wait for the `sidecar-ready` event (emitted by sidecar.rs
            // when PORT_MARKER is captured AND by the External-discovery
            // branch below) before building the window. A 30 s timeout
            // fallback opens the window anyway if the event never fires —
            // better to show a window with an error page than to appear
            // completely unresponsive (if the timeout path fires, the
            // sidecar is genuinely broken and a relaunch is needed).
            {
                use tauri_plugin_store::StoreExt;
                let store = app.store("settings.json").map_err(|e| {
                    log::error!("Failed to open settings store: {}", e);
                    e
                })?;
                if store.get("onboarding_completed").is_none() {
                    log::info!(
                        "First-launch wizard not yet completed; deferring spawn until sidecar-ready"
                    );

                    // Coordination: build the wizard window AT MOST ONCE,
                    // whichever fires first — the sidecar-ready event listener
                    // (preferred) OR the 30-second fallback timeout.
                    let wizard_spawned =
                        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

                    // Preferred path: sidecar-ready event from sidecar.rs.
                    let app_for_listen = app.handle().clone();
                    let spawned_for_listen = wizard_spawned.clone();
                    use tauri::Listener;
                    app.listen("sidecar-ready", move |event| {
                        let port = serde_json::from_str::<serde_json::Value>(event.payload())
                            .ok()
                            .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
                            .map(|p| p as u16)
                            .unwrap_or(3456);
                        spawn_wizard_window_once(&app_for_listen, port, &spawned_for_listen);
                    });

                    // Fallback path: open after 30 s no matter what so the
                    // user isn't staring at a menu-bar icon for half a minute
                    // wondering if the app launched.
                    let app_for_timeout = app.handle().clone();
                    let spawned_for_timeout = wizard_spawned.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                        if !spawned_for_timeout.load(std::sync::atomic::Ordering::SeqCst) {
                            log::warn!(
                                "sidecar-ready event hasn't fired in 30 s; opening wizard with fallback port 3456 — webview will show ECONNREFUSED if sidecar is still down. Relaunch will retry."
                            );
                            spawn_wizard_window_once(&app_for_timeout, 3456, &spawned_for_timeout);
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
                    // Adding the dependency requires VISION.md sign-off.
                    #[allow(deprecated)]
                    let open_result = app
                        .shell()
                        .open("https://github.com/clauding-lab/clauge", None);
                    if let Err(e) = open_result {
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
                        // v0.9.10 (Apple Issue 2 fix): emit sidecar-ready so the
                        // wizard listener fires for the External-discovery path
                        // too. Without this, users with a pre-running clauge
                        // server would never see the wizard build (the wizard
                        // would hit its 30 s timeout fallback instead).
                        use tauri::Emitter;
                        if let Err(e) =
                            app_handle.emit("sidecar-ready", serde_json::json!({ "port": port }))
                        {
                            log::warn!(
                                "Failed to emit sidecar-ready event (External branch): {}",
                                e
                            );
                        }
                    }
                    port_discovery::DiscoveryResult::SpawnAt(_start) => {
                        sidecar::spawn_and_supervise(app_handle).await;
                    }
                }
            });

            // Phase ②b: publish the analytics snapshot to the app's iCloud
            // container on a cadence so the companion iOS app can mirror the
            // desktop analytics. BOTH flavors publish — MAS resolves the
            // container via the ubiquity API (sandbox-correct), the DMG by the
            // direct unsandboxed path. Runs as a SIBLING to the sidecar
            // supervisor (NOT inside its loop, whose shutdown/respawn invariants
            // are delicate) and exits cleanly on quit via AppState::shutdown.
            #[cfg(target_os = "macos")]
            {
                let publish_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    crate::icloud_publish::run(publish_handle).await;
                });
            }

            // v0.9.0 MAS flavor: skip the launch-time updater poll. The
            // `ipc::check_for_updates` FUNCTION stays defined (the Settings
            // → Updates button still calls it on DMG; the MAS variant opens
            // the App Store storefront). Only the cold-start auto-check
            // is gated here — App Store policy forbids in-app updates.
            #[cfg(not(feature = "mas"))]
            {
                let app_handle_updater = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::ipc::check_for_updates(app_handle_updater).await {
                        log::warn!("Updater check on launch failed: {}", e);
                    }
                });
            }
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
            ipc::install_cli_symlink,
            ipc::is_mas_flavor,
            ipc::grant_claude_dir_access,
            ipc::has_claude_dir_bookmark,
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

                // Best-effort port-file cleanup so a stale port doesn't
                // confuse the next CLI run. Idempotent — Ok if absent.
                if let Err(e) = crate::port_file::remove() {
                    log::warn!("port_file::remove on quit failed: {}", e);
                }
            }
        }
    });
}
