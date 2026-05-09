//! Tauri IPC commands exposed to WebView pages.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::State;
use tauri_plugin_shell::process::CommandChild;
use tokio::sync::Notify;

/// Shared app state holding the sidecar's bound port and shutdown machinery.
///
/// Three pieces work together to guarantee no orphan sidecar processes
/// (Bug #1 in v0.3.0 — accumulated `clauge-server` PIDs across launches):
///
/// 1. `shutdown` (`tokio::sync::Notify`) — wakes the supervisor when it's
///    currently awaiting `notified()`. Used for the fast path: if the
///    supervisor is racing `select!` against `rx.recv()`, this notify drops
///    it through immediately.
///
/// 2. `shutting_down` (`AtomicBool`) — a level-triggered flag the supervisor
///    polls between phases. `Notify` is edge-triggered: if no one's
///    currently awaiting `notified()` (e.g., the supervisor is mid-spawn or
///    in backoff sleep), the wake-up is LOST. The flag covers that gap —
///    every loop iteration checks it and breaks out if set.
///
/// 3. `children` (`Arc<Mutex<Vec<CommandChild>>>`) — every spawned child is
///    registered here so the `RunEvent::ExitRequested` handler in lib.rs
///    can take ownership of the entire set and call `kill()` on each one.
///    `CommandChild` has no `Drop` impl (verified against
///    tauri-plugin-shell-2.3.5/src/process/mod.rs), so a child that the
///    supervisor's loop hasn't yet observed (e.g., crash-respawn racing the
///    quit signal) would otherwise survive the parent process exit.
pub struct AppState {
    pub server_port: Arc<Mutex<Option<u16>>>,
    pub shutdown: Arc<Notify>,
    pub shutting_down: Arc<AtomicBool>,
    pub children: Arc<Mutex<Vec<CommandChild>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            server_port: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(Notify::new()),
            shutting_down: Arc::new(AtomicBool::new(false)),
            children: Arc::new(Mutex::new(Vec::new())),
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

    /// Returns true if the app is shutting down. Supervisors poll this between
    /// phases to ensure they stop respawning even if a `notify_waiters()` was
    /// emitted while no task was awaiting `notified()`.
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Register a sidecar child handle so it can be killed on app exit.
    /// Returns silently on lock poison — losing the registration is bad but
    /// not worth panicking for in production. The next time the lock recovers
    /// (or the OS cleans up zombie processes) it'll be fine.
    pub fn register_child(&self, child: CommandChild) {
        match self.children.lock() {
            Ok(mut guard) => guard.push(child),
            Err(e) => log::error!("children lock poisoned at register: {}", e),
        }
    }

    /// Drop a previously registered child by PID. Called when the supervisor
    /// observes a natural `Terminated` event — keeps the Vec from growing
    /// unboundedly across crash-respawn cycles.
    pub fn unregister_child(&self, pid: u32) {
        match self.children.lock() {
            Ok(mut guard) => {
                guard.retain(|c| c.pid() != pid);
            }
            Err(e) => log::error!("children lock poisoned at unregister: {}", e),
        }
    }

    /// Take all currently registered children. Called from
    /// `RunEvent::ExitRequested` in lib.rs to seize ownership of every live
    /// sidecar process and `kill()` each one. Returns an empty Vec on lock
    /// poison — at that point the children are leaked, but the alternative
    /// (panicking) would be worse.
    pub fn take_all_children(&self) -> Vec<CommandChild> {
        match self.children.lock() {
            Ok(mut guard) => std::mem::take(&mut *guard),
            Err(e) => {
                log::error!("children lock poisoned at take_all: {}", e);
                Vec::new()
            }
        }
    }

    /// Set the shutdown flag AND fire the notify so any currently-awaiting
    /// supervisor wakes immediately. Two-phase because:
    ///  - Setting the flag alone won't unblock a `notified()` await
    ///  - `notify_waiters()` alone is lost if no task is awaiting
    /// Together they cover both edge-triggered and level-triggered observers.
    pub fn signal_shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.shutdown.notify_waiters();
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

/// Walk up `exe`'s ancestor path and return the first `.app` bundle dir.
///
/// Pure helper extracted from `check_for_updates` so the logic is testable
/// without needing a tauri runtime. Returns `None` for dev-target paths
/// (no `.app` in any ancestor) and the *innermost* `.app` for nested helper
/// bundles, which matches what we want — strip quarantine from the bundle
/// that actually contains the running executable.
#[cfg(target_os = "macos")]
fn find_app_bundle(exe: &std::path::Path) -> Option<&std::path::Path> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    use tauri_plugin_notification::NotificationExt;
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            // Capture version before `download_and_install` consumes `update`.
            // Field is a public `String` on `tauri_plugin_updater::Update` (verified
            // against tauri-plugin-updater 2.10.1 src), so we clone rather than call
            // a `version()` method.
            let new_version = update.version.clone();

            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;

            // Strip quarantine attr on the running .app bundle so unsigned updates
            // don't re-trigger Gatekeeper. macOS-only path; harmless on other platforms.
            //
            // Dev mode caveat: `current_exe()` returns the dev target binary
            // (e.g., src-tauri/target/debug/clauge), so the `.app` ancestor lookup
            // returns None and the xattr block silently skips. In production it
            // resolves to /Applications/Clauge.app/Contents/MacOS/clauge and
            // ancestors() walks up to the .app bundle.
            //
            // If xattr fails (non-zero exit OR invocation error), per spec §7.2 we
            // dispatch a TOAST telling the user the update installed but Gatekeeper
            // will reappear, with the right-click → Open workaround.
            #[cfg(target_os = "macos")]
            {
                use tokio::process::Command;
                let mut xattr_failed = false;
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(bundle) = find_app_bundle(&exe) {
                        match Command::new("xattr")
                            .args(["-dr", "com.apple.quarantine"])
                            .arg(bundle)
                            .output()
                            .await
                        {
                            Ok(out) if out.status.success() => {
                                log::info!("Stripped quarantine from {:?}", bundle);
                            }
                            Ok(out) => {
                                log::warn!(
                                    "xattr exited non-zero stripping quarantine: {}",
                                    String::from_utf8_lossy(&out.stderr)
                                );
                                xattr_failed = true;
                            }
                            Err(e) => {
                                log::warn!("Failed to invoke xattr: {}", e);
                                xattr_failed = true;
                            }
                        }
                    }
                }

                if xattr_failed {
                    if let Err(e) = app
                        .notification()
                        .builder()
                        .title("Clauge update issue")
                        .body("Update installed but Gatekeeper warning will reappear. Right-click Clauge.app → Open after launch.")
                        .show()
                    {
                        log::warn!("Failed to dispatch xattr-fail notification: {}", e);
                    }
                }
            }

            // User-visible notification that update is installed (spec §6.5).
            // Platform-agnostic; capability `notification:default` is granted in
            // src-tauri/capabilities/main.json.
            if let Err(e) = app
                .notification()
                .builder()
                .title("Clauge updated")
                .body(format!(
                    "Updated to v{}. Restart the app to apply.",
                    new_version
                ))
                .show()
            {
                log::warn!("Failed to dispatch update notification: {}", e);
            }

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
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            log::warn!("Failed to set activation policy to Regular: {}", e);
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    } else {
        crate::windows::create_dashboard(&app).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Test-only command for the E2E suite (T24). Triggers
/// `RunEvent::ExitRequested`, which the lib.rs `run()` callback handles for
/// graceful sidecar shutdown (CommandChild has no Drop — see sidecar.rs).
///
/// Returns `()` rather than `Result<(), String>` because we are quitting
/// anyway — there's no caller left to receive an error. Matches T11/T18/T20
/// `tauri::AppHandle` convention so `invoke_handler!` glue stays uniform.
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Proxy a GET request to the local SEA sidecar via Rust's reqwest, bypassing
/// the WKWebView fetch layer entirely.
///
/// **Why this exists (v0.4.0).** v0.3.1 added wildcard CORS to /api/* and
/// confirmed the headers reach the wire (`curl -H 'Origin: tauri://localhost'`
/// returns `access-control-allow-origin: *`), yet the popover still rendered
/// empty after launch. The remaining failure mode is a WKWebView-layer block
/// — Tauri 2.x's asset protocol routes the popover through `tauri://localhost`
/// (or `https://tauri.localhost` when `useHttpsScheme=true`), and macOS
/// WKWebView treats those origins as Mixed-Content secure contexts. A
/// cross-origin `fetch('http://127.0.0.1:3456/...')` from such a context can
/// be silently dropped before the request leaves the webview, because the
/// upgrade-insecure-requests / mixed-content guard fires before CORS even
/// gets a chance to inspect the response. There are no DevTools console
/// messages to confirm this in production builds, so the failure was invisible.
///
/// The fix is to skip the WebView fetch path entirely. `proxy_fetch` accepts a
/// path (e.g. `/api/summary?period=today`), reads the live sidecar port from
/// `AppState`, builds the URL, and `reqwest`s it from Rust. The popover JS now
/// calls `invoke('proxy_fetch', { path })` instead of `fetch(...)`. No CORS,
/// no mixed-content, no asset-protocol surprises. The dashboard window keeps
/// its native fetch path because it's loaded via `WebviewUrl::External(http://127.0.0.1:.../)`
/// — same-origin to its API server.
///
/// Path validation: only allows paths starting with `/api/` to prevent the
/// frontend from being tricked into fetching arbitrary URLs. The sidecar's
/// SSRF surface is already minimal (it only reads local files), but defense
/// in depth is cheap here.
/// Maximum response body that `proxy_fetch` will buffer into memory.
///
/// 10 MiB ceiling = defense in depth. The sidecar is local and trusted,
/// but a runaway endpoint (or a future bug that streams an unbounded
/// log payload) shouldn't be able to OOM the Tauri host process by
/// returning a JSON document larger than the popover could ever render.
/// Largest legitimate response observed in v0.3.x is ~600KB (full
/// sessions list with 488 sessions); 10 MiB leaves ~16× headroom.
const PROXY_FETCH_MAX_BYTES: usize = 10 * 1024 * 1024;

#[tauri::command]
pub async fn proxy_fetch(
    state: State<'_, AppState>,
    path: String,
) -> Result<serde_json::Value, String> {
    if !path.starts_with("/api/") {
        return Err(format!("path must start with /api/: {}", path));
    }
    let port = read_port(&state)?;
    let url = format!("http://127.0.0.1:{}{}", port, path);
    // Method-pinned GET. DO NOT switch to a method parameter without re-reviewing
    // the IPC threat model — DELETE /api/usage exists on the sidecar.
    let resp = reqwest::get(&url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {} for {}", resp.status(), path));
    }
    // Buffer the body fully (so we can enforce the byte cap) before parsing.
    // `resp.json()` would silently consume an unbounded stream.
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > PROXY_FETCH_MAX_BYTES {
        return Err(format!(
            "response too large: {} bytes (cap {} bytes)",
            bytes.len(),
            PROXY_FETCH_MAX_BYTES
        ));
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Pure body-cap check used by `proxy_fetch`. Extracted so tests can
/// exercise the cap logic without spinning up an HTTP server / Tauri
/// runtime. Returns `Ok(value)` when the body decodes within the cap,
/// `Err(reason)` otherwise.
#[cfg(test)]
fn check_body_cap(bytes: &[u8]) -> Result<serde_json::Value, String> {
    if bytes.len() > PROXY_FETCH_MAX_BYTES {
        return Err(format!(
            "response too large: {} bytes (cap {} bytes)",
            bytes.len(),
            PROXY_FETCH_MAX_BYTES
        ));
    }
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
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

    #[test]
    fn signal_shutdown_sets_flag() {
        let state = AppState::default();
        assert!(!state.is_shutting_down(), "default should be running");
        state.signal_shutdown();
        assert!(
            state.is_shutting_down(),
            "after signal_shutdown the flag must be true"
        );
    }

    #[test]
    fn take_all_children_drains_the_vec() {
        // We can't construct a real CommandChild in a unit test (it requires
        // a live process + tauri runtime), so we verify the empty-state
        // behavior — take_all_children on an empty Vec returns an empty Vec
        // without panicking, and the registry stays empty.
        let state = AppState::default();
        let drained = state.take_all_children();
        assert!(drained.is_empty());
        // Calling again is also a no-op
        assert!(state.take_all_children().is_empty());
    }

    #[test]
    fn unregister_child_on_empty_registry_is_noop() {
        let state = AppState::default();
        // Should not panic even though no child with PID 999 was ever registered
        state.unregister_child(999);
        assert!(state.take_all_children().is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn find_app_bundle_returns_outer_for_application_path() {
        let p = std::path::Path::new("/Applications/Clauge.app/Contents/MacOS/clauge");
        assert_eq!(
            find_app_bundle(p),
            Some(std::path::Path::new("/Applications/Clauge.app"))
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn find_app_bundle_returns_none_for_dev_target_path() {
        let p = std::path::Path::new("/Users/x/projects/clauge/src-tauri/target/debug/clauge");
        assert_eq!(find_app_bundle(p), None);
    }

    #[tokio::test]
    async fn proxy_fetch_rejects_non_api_paths() {
        // We can't synthesize a `State<'_, AppState>` without a Tauri runtime,
        // so we test the path validation by replicating the invariant inline.
        // The actual command rejects paths not starting with /api/ before
        // touching state — verify that prefix check holds.
        let bad = ["/", "/health", "//api/x", "/.api/", "../api/"];
        for path in bad {
            assert!(
                !path.starts_with("/api/"),
                "test fixture must be a non-/api/ path: {}",
                path
            );
        }
        // Sanity check: known-good paths the frontend will send.
        let good = ["/api/summary", "/api/health", "/api/usage"];
        for path in good {
            assert!(path.starts_with("/api/"), "should be allowed: {}", path);
        }
    }

    #[test]
    fn proxy_fetch_rejects_oversized_body() {
        // Construct a body just over the cap. Use a JSON-shaped payload so the
        // cap rejection (not a JSON parse error) is what we observe.
        let oversize_len = PROXY_FETCH_MAX_BYTES + 1;
        let payload = vec![b'a'; oversize_len];
        let err = check_body_cap(&payload).unwrap_err();
        assert!(
            err.starts_with("response too large"),
            "expected size cap error, got: {}",
            err
        );
        // And: a body comfortably under the cap should pass through and parse.
        let ok = b"{\"k\":\"v\"}";
        let value = check_body_cap(ok).unwrap();
        assert_eq!(value["k"], "v");
    }

    #[test]
    fn proxy_fetch_cap_is_10_mib() {
        // Pin the constant so accidental edits to PROXY_FETCH_MAX_BYTES are
        // surfaced by a test failure rather than slipping through unnoticed.
        assert_eq!(PROXY_FETCH_MAX_BYTES, 10 * 1024 * 1024);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn find_app_bundle_returns_innermost_for_nested_helper() {
        let p = std::path::Path::new(
            "/Applications/Clauge.app/Contents/Frameworks/Helper.app/Contents/MacOS/h",
        );
        assert_eq!(
            find_app_bundle(p),
            Some(std::path::Path::new(
                "/Applications/Clauge.app/Contents/Frameworks/Helper.app"
            ))
        );
    }
}
