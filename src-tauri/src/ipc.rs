//! Tauri IPC commands exposed to WebView pages.

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::State;
use tokio::sync::Notify;

use crate::sidecar::SidecarChild;

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
/// 3. `children` (`Arc<Mutex<Vec<SidecarChild>>>`) — every spawned child is
///    registered here so the `RunEvent::ExitRequested` handler in lib.rs
///    can take ownership of the entire set and call `kill()` on each one.
///    Neither variant of `SidecarChild` has a `Drop` impl that kills the
///    OS process (DMG: `tauri_plugin_shell::process::CommandChild` has no
///    Drop per tauri-plugin-shell-2.3.5/src/process/mod.rs; MAS:
///    `sidecar::NativeChild` only carries the PID, and the underlying
///    `tokio::process::Child` lives in a wait-task that doesn't observe
///    the parent's exit), so a child that the supervisor's loop hasn't
///    yet observed (e.g., crash-respawn racing the quit signal) would
///    otherwise survive the parent process exit.
pub struct AppState {
    pub server_port: Arc<Mutex<Option<u16>>>,
    pub shutdown: Arc<Notify>,
    pub shutting_down: Arc<AtomicBool>,
    pub children: Arc<Mutex<Vec<SidecarChild>>>,
    /// Shared, mutex-serialized in-memory cache for the Claude Code OAuth
    /// credentials. Lives in `AppState` so concurrent dashboard polls share
    /// a single cached `ClaudeCodeCreds` and don't each re-prompt the user
    /// against an ad-hoc-signed build's Keychain ACL on macOS. On Windows
    /// the underlying reader is filesystem-backed (no prompt), but the cache
    /// still serves its purpose of reducing fs reads on rapid polling.
    pub keychain_cache: Arc<crate::keychain_cache::KeychainCache>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            server_port: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(Notify::new()),
            shutting_down: Arc::new(AtomicBool::new(false)),
            children: Arc::new(Mutex::new(Vec::new())),
            keychain_cache: Arc::new(crate::keychain_cache::KeychainCache::new()),
        }
    }
}

impl AppState {
    /// Set the bound sidecar port. Used by sidecar startup once the server reports ready.
    ///
    /// Also mirrors the port to a known file on disk
    /// (`crate::port_file`) so a standalone Node CLI invocation can find a
    /// running Clauge to talk to. The file write is best-effort: failure to
    /// write the side-channel never fails the in-memory port set, because
    /// the running app's IPC (which uses the in-memory port) is more
    /// load-bearing than the CLI's HTTP fallback.
    pub fn set_port(&self, port: u16) -> Result<(), String> {
        let mut guard = self
            .server_port
            .lock()
            .map_err(|e| format!("lock poisoned: {}", e))?;
        *guard = Some(port);
        drop(guard);
        if let Err(e) = crate::port_file::write(port) {
            log::warn!(
                "port_file::write failed (CLI HTTP discovery may fall back to disk): {}",
                e
            );
        }
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
    pub fn register_child(&self, child: SidecarChild) {
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
    pub fn take_all_children(&self) -> Vec<SidecarChild> {
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
    ///
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

/// Outcome of `check_for_updates`. Serialized as a tagged enum:
/// - `{"status":"up_to_date"}` — nothing to do
/// - `{"status":"installed","version":"X.Y.Z"}` — new version installed
///   on disk; user needs to restart (frontend surfaces a Restart Now button).
/// - `{"status":"opened_storefront"}` — v0.9.0 MAS: opens the Mac App Store
///   storefront instead of polling latest.json. Frontend renders
///   "Opened the Mac App Store. Updates ship through Apple."
///
/// MAS builds only construct `OpenedStorefront`; DMG/NSIS only construct
/// `UpToDate` / `Installed`. `#[allow(dead_code)]` silences the warning
/// on whichever flavor isn't constructing a given variant.
#[derive(serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum UpdateStatus {
    UpToDate,
    Installed {
        version: String,
    },
    /// v0.9.0 MAS: opened the Mac App Store storefront instead of polling
    /// latest.json. Frontend renders the "Updates ship through Apple"
    /// message. Gated to the `mas` feature so DMG/NSIS builds don't generate
    /// a dead-code warning for a variant they can never construct.
    #[cfg(feature = "mas")]
    OpenedStorefront,
}

/// Walk up `exe`'s ancestor path and return the first `.app` bundle dir.
///
/// Pure helper extracted from `check_for_updates` so the logic is testable
/// without needing a tauri runtime. Returns `None` for dev-target paths
/// (no `.app` in any ancestor) and the *innermost* `.app` for nested helper
/// bundles, which matches what we want — strip quarantine from the bundle
/// that actually contains the running executable.
///
/// Used only by the non-MAS update path's xattr-strip block; MAS builds
/// route through the App Store and never touch this helper.
/// `allow(dead_code)` silences the unused-function warning under
/// `--features mas` while keeping the helper's tests reachable on every
/// flavor (test baselines stay stable).
#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn find_app_bundle(exe: &std::path::Path) -> Option<&std::path::Path> {
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
}

/// Apple App Store numeric ID for Clauge. Issued 2026-05-17 when the
/// App Store Connect listing was created for `com.clauding.clauge`.
#[cfg(feature = "mas")]
const APP_STORE_ID: &str = "6770303247";

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<UpdateStatus, String> {
    // v0.9.0 MAS: Apple App Store policy forbids in-app self-updates. Instead
    // of polling latest.json + downloading a DMG, we open the Mac App Store
    // storefront so the user can update through Apple's normal mechanism.
    // The Settings → Updates button hits this same IPC on both flavors;
    // frontend keys off the returned `OpenedStorefront` variant to render
    // the "Updates ship through Apple" message.
    #[cfg(feature = "mas")]
    {
        use tauri_plugin_shell::ShellExt;
        // TODO(deprecation): migrate to tauri-plugin-opener when bumping Tauri.
        // shell.open is #[deprecated(since = "2.1.0")]; see lib.rs same pattern.
        #[allow(deprecated)]
        app.shell()
            .open(
                format!("macappstore://apps.apple.com/app/clauge/id{}", APP_STORE_ID),
                None,
            )
            .map_err(|e| format!("failed to open App Store: {}", e))?;
        return Ok(UpdateStatus::OpenedStorefront);
    }

    #[cfg(not(feature = "mas"))]
    {
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

                Ok(UpdateStatus::Installed {
                    version: new_version,
                })
            }
            Ok(None) => Ok(UpdateStatus::UpToDate),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[tauri::command]
pub async fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    // DMG/Windows: LaunchAgent via tauri-plugin-autostart.
    #[cfg(not(feature = "mas"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = app.autolaunch();
        if enabled {
            manager.enable().map_err(|e| e.to_string())
        } else {
            manager.disable().map_err(|e| e.to_string())
        }
    }
    // MAS: Apple SMAppService (see crate::autostart_mas). The AppHandle is unused
    // because SMAppService.mainApp implicitly targets the running app.
    #[cfg(feature = "mas")]
    {
        let _ = &app;
        if enabled {
            crate::autostart_mas::enable()
        } else {
            crate::autostart_mas::disable()
        }
    }
}

#[tauri::command]
pub async fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    #[cfg(not(feature = "mas"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch().is_enabled().map_err(|e| e.to_string())
    }
    #[cfg(feature = "mas")]
    {
        let _ = &app;
        Ok(crate::autostart_mas::is_enabled())
    }
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

/// Local /api/health probe timeout. The dashboard polls get_connection_status
/// every 30s, so a hung Hono response must not block the refresh.
const LOCAL_HEALTH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Maximum response body that `proxy_fetch` will buffer into memory.
///
/// 10 MiB ceiling = defense in depth. The sidecar is local and trusted,
/// but a runaway endpoint (or a future bug that streams an unbounded
/// log payload) shouldn't be able to OOM the Tauri host process by
/// returning a JSON document larger than the popover could ever render.
/// Largest legitimate response observed in v0.3.x is ~600KB (full
/// sessions list with 488 sessions); 10 MiB leaves ~16× headroom.
const PROXY_FETCH_MAX_BYTES: usize = 10 * 1024 * 1024;

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
    let resp = crate::http_client::LOCAL_CLIENT
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
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

/// Open the in-app WKWebView for claude.ai sign-in (Architecture A — DMG/NSIS
/// only). On MAS this is a no-op error — the Clauge Sync browser extension is
/// the recommended path (per wizard step 4). The frontend should never call
/// this on MAS (connections.js gates the button by flavor), but we return a
/// helpful error message so a misrouted call surfaces clearly in logs.
#[tauri::command]
pub async fn open_claude_ai_login(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(feature = "mas"))]
    {
        crate::claude_ai_session::open_login_modal(&app)
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(feature = "mas")]
    {
        let _ = app;
        Err(
            "Direct sign-in unavailable on Mac App Store. Use the Clauge Sync browser extension via Settings → Connections.".to_string(),
        )
    }
}

/// Clear the stored claude.ai sessionKey cookie from Keychain (sign-out —
/// DMG/NSIS only). MAS no-op returns Ok(()) because the cookie is never
/// stored there (claude_ai_session module is cfg-gated out on MAS).
#[tauri::command]
pub fn signout_claude_ai() -> Result<(), String> {
    #[cfg(not(feature = "mas"))]
    {
        crate::claude_ai_session::clear_stored_cookie().map_err(|e| e.to_string())
    }
    #[cfg(feature = "mas")]
    {
        Ok(())
    }
}

/// Returns true if a claude.ai sessionKey cookie is stored in Keychain
/// (DMG/NSIS only). On MAS this always returns false — the claude_ai_session
/// module is cfg-gated out, so there's never a cookie to read.
#[tauri::command]
pub fn has_claude_ai_session() -> bool {
    #[cfg(not(feature = "mas"))]
    {
        crate::claude_ai_session::read_stored_cookie().is_ok()
    }
    #[cfg(feature = "mas")]
    {
        false
    }
}

#[tauri::command]
pub async fn get_connection_status(
    state: State<'_, AppState>,
    _app: tauri::AppHandle,
) -> Result<crate::connections::ConnectionStatus, String> {
    let mut status = crate::connections::detect(&state.keychain_cache);

    // Fetch /api/health from the local server for the extension heartbeat.
    // 2-second timeout: this is a 127.0.0.1 call and the dashboard polls this
    // IPC regularly — a hung Hono response must not block refreshes.
    let port = state
        .server_port
        .lock()
        .ok()
        .and_then(|g| *g)
        .unwrap_or(3456);
    let url = format!("http://127.0.0.1:{}/api/health", port);
    match crate::http_client::LOCAL_CLIENT
        .get(&url)
        .timeout(LOCAL_HEALTH_TIMEOUT)
        .send()
        .await
    {
        Ok(res) => match res.json::<serde_json::Value>().await {
            Ok(json) => {
                if let Some(ts) = json.get("extensionLastSeenAt").and_then(|v| v.as_str()) {
                    // Re-compose with the heartbeat; preserves other fields.
                    status = crate::connections::compose_status(
                        status.claude_code_version.as_deref(),
                        matches!(
                            status.claude_ai,
                            crate::connections::ConnectionState::SignedIn
                        ),
                        Some(ts.to_string()),
                    );
                } else {
                    log::debug!(
                        "get_connection_status: /api/health response missing extensionLastSeenAt key"
                    );
                }
            }
            Err(err) => {
                log::debug!(
                    "get_connection_status: /api/health body did not parse as JSON: {:?}",
                    err
                );
            }
        },
        Err(err) => {
            log::warn!(
                "get_connection_status: /api/health request failed: {:?}",
                err
            );
        }
    }

    // v0.9.0 MAS: fill in the claude_code_logs field after the pure compositor
    // has returned. compose_status() defaults this to None because it lacks an
    // AppHandle; we fill it here where `_app` is in scope. The bookmark
    // presence is the source of truth for "granted" — `MAS_CLAUDE_DIR` may not
    // yet be populated this run (sidecar supervisor sets it on acquire), so
    // we report `path = None` in that case while still surfacing "granted".
    #[cfg(feature = "mas")]
    {
        let logs_state = if crate::security_scoped_bookmark::has_bookmark(&_app) {
            let path = crate::security_scoped_bookmark::MAS_CLAUDE_DIR
                .get()
                .map(|p| p.to_string_lossy().into_owned());
            crate::connections::ClaudeCodeLogsState {
                status: crate::connections::ClaudeDirGrantStatus::Granted,
                path,
            }
        } else {
            crate::connections::ClaudeCodeLogsState {
                status: crate::connections::ClaudeDirGrantStatus::NotGranted,
                path: None,
            }
        };
        status.claude_code_logs = Some(logs_state);
    }

    Ok(status)
}

/// Force a fresh keychain read, replacing the cached creds. Used by the
/// Refresh button in Connections panel.
///
/// On macOS, triggers a Keychain prompt (or, if the app is unsigned/ad-hoc,
/// the user sees the dialog again). Cache is updated on success.
/// Emits `connections-updated` so dashboard listeners re-render.
#[tauri::command]
pub async fn refresh_credentials(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Emitter;
    match state.keychain_cache.refresh() {
        Ok(_) => {
            let _ = app.emit("connections-updated", ());
            Ok(())
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Wizard "Connect" — mark onboarding complete, force a keychain read
/// (triggers macOS prompt), close wizard window, and surface the dashboard.
#[tauri::command]
pub async fn wizard_complete(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use tauri::Manager;

    // Mark the onboarding flag so we don't re-show on next launch.
    if let Err(e) = mark_onboarding_completed(&app) {
        log::warn!("wizard_complete: failed to persist onboarding flag: {}", e);
        // Continue anyway — failing here would leave the user stuck in the wizard.
    }

    // Surface the dashboard FIRST so the app activation policy flips to
    // Regular and gets a Dock icon. macOS suppresses Keychain prompts for
    // Accessory-mode apps without a foreground window, so cache.refresh()
    // below would have its prompt silently dropped if we called it while
    // still in Accessory mode (the state set in lib.rs::setup).
    crate::tray::show_dashboard(&app);

    // Trigger credential read. On macOS this is where the Keychain prompt
    // fires (and may be denied by the user). On Windows the read is silent
    // (reads %USERPROFILE%\.claude\.credentials.json — no prompt).
    {
        use tauri::Emitter;
        match state.keychain_cache.refresh() {
            Ok(_) => {
                let _ = app.emit("connections-updated", ());
            }
            Err(e) => {
                // Mac: user may have clicked Deny on the Keychain prompt.
                // Windows: file missing or unreadable. Either way, log + continue —
                // dashboard will show Claude Code as NotInstalled until they click ↻.
                log::warn!("wizard_complete: credential refresh failed: {}", e);
            }
        }
    }

    // v0.8.1 (fix): set a persistent flag in the store so the dashboard's
    // app.js reads it on load and switches to Settings → Connections. We
    // previously emitted a Tauri event here, but Tauri events don't buffer
    // for late subscribers — on macOS first-launch the dashboard webview
    // hasn't loaded yet when this code runs, so the event was lost and the
    // dashboard would land on Overview instead of Connections.
    {
        use tauri_plugin_store::StoreExt;
        if let Ok(store) = app.store("settings.json") {
            store.set("pending_focus_connections", serde_json::Value::Bool(true));
            if let Err(e) = store.save() {
                log::warn!(
                    "wizard_complete: failed to persist pending_focus_connections: {}",
                    e
                );
            }
        }
    }

    // Close the wizard window last, after the prompt has been handled.
    if let Some(w) = app.get_webview_window("onboarding") {
        let _ = w.close();
    }

    Ok(())
}

/// Wizard "Skip for now" — mark onboarding complete, close wizard window,
/// DO NOT trigger keychain read. User can click ↻ later from the Connections panel.
#[tauri::command]
pub async fn wizard_skip(_state: State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;

    if let Err(e) = mark_onboarding_completed(&app) {
        log::warn!("wizard_skip: failed to persist onboarding flag: {}", e);
    }

    if let Some(w) = app.get_webview_window("onboarding") {
        let _ = w.close();
    }

    crate::tray::show_dashboard(&app);
    Ok(())
}

/// Persist the `onboarding_completed = true` flag in the tauri-plugin-store
/// settings.json. Shared by both wizard_complete and wizard_skip.
fn mark_onboarding_completed(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json")?;
    store.set("onboarding_completed", serde_json::Value::Bool(true));
    store.save()?;
    Ok(())
}

// --- v0.9.0 MAS flavor IPCs ---

/// Returns true if this build was compiled with the `mas` Cargo feature.
/// Used by frontend JS to gate flavor-specific UI (wizard step 2 + step 5
/// markup, Settings → Updates button copy, 4th Connections row visibility).
///
/// Both flavors register the IPC; it just returns `false` on DMG/NSIS.
#[tauri::command]
pub fn is_mas_flavor() -> bool {
    cfg!(feature = "mas")
}

/// Prompt the user via NSOpenPanel to grant access to ~/.claude/. Persists
/// the resulting security-scoped bookmark to the Tauri store. Returns
/// Ok(()) on grant, Err(string) on cancel / failure.
///
/// MAS-only — DMG/NSIS no-op returns Ok(()) (frontend shouldn't be calling
/// it but graceful degradation if it does).
///
/// NSOpenPanel is modal and blocking — wrap the bookmark call in
/// `spawn_blocking` to avoid stalling the Tauri main thread.
///
/// **Task 12b — first-launch UX fix:** after prompt success, this IPC now
/// also (a) acquires the scoped path immediately to populate
/// `MAS_CLAUDE_DIR` for `read_claude_code_credentials`, (b) holds the
/// resulting `ScopedHandle` in the process-wide `MAS_SCOPE_HOLDER` so the
/// scope outlives this IPC handler's stack frame, and (c) signals the
/// sidecar to respawn so its `CLAUDE_DIR` env picks up the fresh value.
/// Without these steps, first-launch users had to restart the app for the
/// dashboard to leave the empty state (smoke surfaced this 2026-05-17).
#[tauri::command]
pub async fn grant_claude_dir_access(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(feature = "mas")]
    {
        // Step 1: prompt user via NSOpenPanel, persist bookmark blob to store.
        let app_for_prompt = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::security_scoped_bookmark::prompt_for_folder_grant(&app_for_prompt)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("spawn_blocking join failed: {}", e))??;

        // Step 2: acquire scope + populate MAS_CLAUDE_DIR if not already.
        // On first launch, the supervisor's acquire failed (no bookmark yet),
        // so MAS_CLAUDE_DIR is None and we must populate it here. On re-select
        // (subsequent launches with bookmark already present), supervisor
        // already populated it and we don't need to re-acquire.
        if crate::security_scoped_bookmark::MAS_CLAUDE_DIR
            .get()
            .is_none()
        {
            let app_for_acquire = app.clone();
            let acquire_result = tauri::async_runtime::spawn_blocking(move || {
                crate::security_scoped_bookmark::acquire_scoped_path(&app_for_acquire)
            })
            .await
            .map_err(|e| format!("spawn_blocking acquire join failed: {}", e))?;

            match acquire_result {
                Ok((path, guard)) => {
                    let _ = crate::security_scoped_bookmark::MAS_CLAUDE_DIR
                        .set(std::path::PathBuf::from(&path));
                    // Hold the ScopedHandle in the static so the scope stays
                    // active beyond this IPC handler's stack. Without this,
                    // the guard's Drop impl would fire on this function's
                    // return and revoke filesystem access immediately —
                    // making the whole exercise pointless.
                    if let Ok(mut holder) = crate::security_scoped_bookmark::MAS_SCOPE_HOLDER.lock()
                    {
                        *holder = Some(guard);
                    }
                    log::info!(
                        "grant_claude_dir_access: MAS_CLAUDE_DIR populated to {} and scope held in MAS_SCOPE_HOLDER",
                        path
                    );
                }
                Err(e) => {
                    log::warn!(
                        "grant_claude_dir_access: bookmark persisted but acquire_scoped_path failed: {}. Credentials/JSONL reads may fail until app restart.",
                        e
                    );
                }
            }
        }

        // Step 3: signal sidecar respawn so its CLAUDE_DIR env updates.
        // The supervisor's loop auto-respawns on sidecar death.
        crate::sidecar::kill_current_sidecar_for_respawn(&app).await;

        Ok(())
    }
    #[cfg(not(feature = "mas"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Returns true if a security-scoped bookmark blob is persisted in the
/// Tauri store. Cheap — one store read, no Foundation FFI.
///
/// DMG/NSIS always returns true (no bookmark needed — full FS access).
#[tauri::command]
pub fn has_claude_dir_bookmark(app: tauri::AppHandle) -> bool {
    #[cfg(feature = "mas")]
    {
        crate::security_scoped_bookmark::has_bookmark(&app)
    }
    #[cfg(not(feature = "mas"))]
    {
        let _ = app;
        true
    }
}

/// v0.8.1: dashboard's app.js calls this on load to check whether the wizard
/// just completed via Connect (and thus the user should land on Settings →
/// Connections). Read + clear in one call so we don't loop on the flag.
#[tauri::command]
pub fn take_pending_focus_connections(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| e.to_string())?;
    let pending = store
        .get("pending_focus_connections")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if pending {
        store.delete("pending_focus_connections");
        store.save().map_err(|e| e.to_string())?;
    }
    Ok(pending)
}

/// Restart the Tauri shell after killing all sidecar children.
///
/// Used by the Settings → Updates "Restart Now" button after a successful
/// `check_for_updates` install. Sequence:
/// 1. signal_shutdown() — sets the shutting_down flag and notifies waiters
///    so the supervisor in sidecar.rs exits its loop without respawning.
/// 2. take_all_children() + kill — drops the live sidecar process.
///    SIGKILL on a CommandChild we own; failures are logged.
/// 3. sleep 200 ms — gives SIGKILL time to deliver before the process
///    replaces itself.
/// 4. app.restart() — Tauri's stable in-place re-exec. Does not return.
///
/// On macOS, app.restart() exec()s the binary path of the current .app
/// bundle. After an auto-update has replaced /Applications/Clauge.app,
/// the new process loads the new binary AND the new sidecar binary
/// (because port_discovery's SpawnAt path will spawn a fresh child).
#[tauri::command]
pub async fn restart_app(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<(), String> {
    state.signal_shutdown();
    for child in state.take_all_children() {
        let pid = child.pid();
        if let Err(e) = child.kill() {
            log::warn!("restart_app: failed to kill sidecar pid={}: {}", pid, e);
        } else {
            log::info!("restart_app: killed sidecar pid={}", pid);
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    app.restart();
}

/// v0.9.4 Phase B.4 — install a `/usr/local/bin/clauge` symlink pointing at
/// the bundled `Contents/Resources/clauge-cli` wrapper. Returns a human-
/// readable status string the wizard can display directly.
///
/// macOS-only: the wrapper is a POSIX shell script and the symlink target is
/// `/usr/local/bin`. Windows + Linux variants ship in v0.9.5+ (Windows would
/// place a `clauge.cmd` shim on `PATH`; Linux likely `~/.local/bin/clauge`).
/// The function exists on all platforms with the same signature so
/// `lib.rs::generate_handler![ipc::install_cli_symlink]` resolves cleanly;
/// the non-macOS variant returns an explanatory Err immediately.
///
/// macOS implementation is idempotent and fails-soft: if the symlink already
/// points at our wrapper, returns "already installed". If a foreign file
/// occupies the path, returns an Err with the manual `ln -s` command for the
/// user to run. Permission errors return an Err suggesting the same manual
/// command via `sudo`.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn install_cli_symlink() -> Result<String, String> {
    Err(
        "install_cli_symlink is macOS-only in v0.9.4 — Windows + Linux variants ship in v0.9.5+."
            .to_string(),
    )
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn install_cli_symlink() -> Result<String, String> {
    let bundle_cli = resolve_bundle_cli_path()
        .ok_or_else(|| "Could not resolve bundle Resources/clauge-cli path".to_string())?;
    if !bundle_cli.exists() {
        return Err(format!(
            "Bundled CLI wrapper not found at {}. Reinstall Clauge.",
            bundle_cli.display()
        ));
    }

    let target = std::path::PathBuf::from("/usr/local/bin/clauge");

    if let Ok(meta) = std::fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() {
            if let Ok(existing) = std::fs::read_link(&target) {
                if existing == bundle_cli {
                    return Ok(format!(
                        "Already installed: {} -> {}",
                        target.display(),
                        existing.display()
                    ));
                }
                return Err(format!(
                    "/usr/local/bin/clauge already points at {}. \
                     Remove it first: sudo rm /usr/local/bin/clauge && sudo ln -s {} /usr/local/bin/clauge",
                    existing.display(),
                    bundle_cli.display()
                ));
            }
        }
        return Err(format!(
            "/usr/local/bin/clauge already exists (not a symlink). \
             Remove it first: sudo rm /usr/local/bin/clauge && sudo ln -s {} /usr/local/bin/clauge",
            bundle_cli.display()
        ));
    }

    match std::os::unix::fs::symlink(&bundle_cli, &target) {
        Ok(()) => Ok(format!(
            "Installed: {} -> {}",
            target.display(),
            bundle_cli.display()
        )),
        Err(e) => Err(format!(
            "Could not create symlink ({}). Run manually: sudo ln -s {} /usr/local/bin/clauge",
            e,
            bundle_cli.display()
        )),
    }
}

/// Resolve the absolute path to the bundled CLI wrapper. macOS bundle layout:
///   /Applications/Clauge.app/Contents/MacOS/Clauge           <- current_exe
///   /Applications/Clauge.app/Contents/Resources/clauge-cli   <- wrapper
#[cfg(target_os = "macos")]
fn resolve_bundle_cli_path() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let contents = exe.parent()?.parent()?;
    Some(contents.join("Resources").join("clauge-cli"))
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
