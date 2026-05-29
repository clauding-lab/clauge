//! Sidecar process lifecycle + crash circuit-breaker.
//!
//! Spawns the clauge-server SEA binary as a child process via tauri-plugin-shell.
//! Tracks crash timestamps in a 60s sliding window. After 3 crashes within 60s,
//! dispatches a one-shot notification; from the 4th crash, respawns with
//! exponential backoff (2s, 4s, 8s capped) until the window empties.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct CrashBreaker {
    crashes: VecDeque<Instant>,
    window: Duration,
    notification_sent: bool,
}

impl CrashBreaker {
    pub fn new() -> Self {
        Self {
            crashes: VecDeque::new(),
            window: Duration::from_secs(60),
            notification_sent: false,
        }
    }

    /// Returns true if a notification has been emitted in the current window.
    /// Resets to false when the 60s window empties.
    ///
    /// Kept for future telemetry/dashboard surfaces; not currently invoked.
    #[allow(dead_code)]
    pub fn was_notified(&self) -> bool {
        self.notification_sent
    }

    /// Record a crash. Returns the recommended action.
    pub fn record(&mut self, now: Instant) -> CrashAction {
        // Window is closed-closed: a crash at exactly t=now-window_secs is kept
        // (matches the spec's "older than 60s" wording, which reads as strict >).
        while let Some(&front) = self.crashes.front() {
            if now.duration_since(front) > self.window {
                self.crashes.pop_front();
            } else {
                break;
            }
        }
        // If the window is empty after pruning, reset notification state
        if self.crashes.is_empty() {
            self.notification_sent = false;
        }
        self.crashes.push_back(now);

        match self.crashes.len() {
            1 | 2 => CrashAction::SilentRespawn,
            3 => {
                if self.notification_sent {
                    CrashAction::SilentRespawn
                } else {
                    self.notification_sent = true;
                    CrashAction::NotifyAndRespawn
                }
            }
            n => {
                // Exponential backoff after #4: 2s, 4s, 8s (capped)
                let exp = (n - 3).min(3);
                let backoff = Duration::from_secs(1 << exp);
                CrashAction::BackoffRespawn(backoff)
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
// Postfix "Respawn" is intentional: every variant describes WHAT KIND of
// respawn occurs. Removing it would make match arms read worse, not better
// (`CrashAction::Silent` vs `CrashAction::SilentRespawn` — the latter is clearer
// because the enum's whole purpose is choosing a respawn flavor).
#[allow(clippy::enum_variant_names)]
pub enum CrashAction {
    SilentRespawn,
    NotifyAndRespawn,
    /// Respawn after a delay. Schedule for crashes 4..=N within the window:
    /// 2s, 4s, 8s, 8s, 8s, ... (capped at 8s).
    BackoffRespawn(Duration),
}

use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

// DMG-only Tauri shell-plugin spawn path. MAS bypasses the shell plugin
// entirely (see spawn_native_helper below), so these imports are gated to
// avoid "unused import" warnings under --features mas.
#[cfg(not(feature = "mas"))]
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
#[cfg(not(feature = "mas"))]
use tauri_plugin_shell::ShellExt;

const PORT_MARKER: &str = "CLAUGE_BOUND_PORT=";

// ============================================================================
// Sidecar child + event abstraction (helper.app architecture for MAS, v0.9.10)
// ============================================================================
//
// The DMG flavor spawns the SEA Node binary via `app.shell().sidecar(...)`,
// which expects the binary at `Contents/MacOS/clauge-server` and returns a
// `tauri_plugin_shell::process::CommandChild` + `Receiver<CommandEvent>`.
//
// The MAS flavor cannot use that path: Apple's Transporter validation
// requires `app-sandbox=true` on every Mach-O in the bundle, but a
// standalone Mach-O at `Contents/MacOS/clauge-server` with `app-sandbox`
// SIGTRAPs at runtime in `libsystem_secinit::_libsecinit_appsandbox`
// (no embedded `Info.plist` → no `CFBundleIdentifier` → secinitd can't
// set up the per-binary container). The Apple-documented fix is to wrap
// the helper in its own `.app` bundle under `Contents/Helpers/Clauge
// Helper.app/`, which provides the `Info.plist` + `CFBundleIdentifier`
// the sandbox machinery needs. Build script `scripts/build-mas-clean.sh`
// performs the wrap post-Tauri-build.
//
// At runtime, Tauri's `Shell::sidecar(name)` API hardcodes the
// `Contents/MacOS/<name>` lookup with no override hook, so the MAS branch
// bypasses Tauri's shell plugin entirely and spawns via
// `tokio::process::Command` from the helper's absolute path. The unified
// `SidecarChild` enum + `SidecarEvent` enum below adapt both spawn paths
// to a single supervisor implementation; AppState stores `SidecarChild`
// (vs. the previous `CommandChild`) so the quit-time kill loop in lib.rs
// doesn't care which path produced the children.

/// Subset of `tauri_plugin_shell::process::CommandEvent` we actually consume.
///
/// We only care about Stderr lines (to scan for `CLAUGE_BOUND_PORT=` markers)
/// and process termination (for the crash supervisor). Stdout, intermediate
/// "error" events, and other Tauri-specific signals are filtered out at the
/// forwarder. Using a custom enum lets the supervisor write one match arm
/// instead of two cfg-gated ones.
pub enum SidecarEvent {
    Stderr(Vec<u8>),
    Terminated {
        code: Option<i32>,
        signal: Option<i32>,
    },
}

/// MAS-only minimal child handle.
///
/// Holds only the PID. `kill()` issues SIGTERM via `libc::kill(pid,
/// SIGTERM)` directly — we don't need to own the `tokio::process::Child`
/// for kill because the wait-task in `spawn_native_helper` already owns
/// it (and surfaces `SidecarEvent::Terminated` when the kernel reaps the
/// process). This dodges the `&mut self` constraint on
/// `tokio::process::Child::kill()` which would otherwise force a Mutex
/// or oneshot-channel dance to call kill from the supervisor's quit
/// path while the wait task is concurrently `await`-ing on the same
/// Child.
#[cfg(feature = "mas")]
pub struct NativeChild {
    pid: u32,
}

#[cfg(feature = "mas")]
impl NativeChild {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn kill(self) -> std::io::Result<()> {
        // SIGTERM (vs SIGKILL) gives the SEA Node binary a chance to flush
        // any in-flight log writes / Tauri store fsyncs before exit. The
        // supervisor's grace window (lib.rs `std::thread::sleep(200ms)` in
        // the ExitRequested handler) covers the time between SIGTERM and
        // the kernel reaping the child.
        //
        // SAFETY: `libc::kill` is signal-safe and well-defined for any i32
        // pid; if the pid doesn't match a process we own, kill returns -1
        // with errno set (EPERM / ESRCH), surfaced as a normal io::Error.
        // The u32→i32 cast is value-preserving for real macOS PIDs (kernel
        // PID max is ~99999, well within i32::MAX).
        let ret = unsafe { libc::kill(self.pid as i32, libc::SIGTERM) };
        if ret == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

/// Unified child handle — wraps `CommandChild` (DMG) or `NativeChild` (MAS).
///
/// AppState stores `Vec<SidecarChild>` so the quit-time kill loop in lib.rs
/// + `kill_current_sidecar_for_respawn` here are flavor-agnostic.
pub enum SidecarChild {
    #[cfg(not(feature = "mas"))]
    Tauri(CommandChild),
    #[cfg(feature = "mas")]
    Native(NativeChild),
}

impl SidecarChild {
    pub fn pid(&self) -> u32 {
        match self {
            #[cfg(not(feature = "mas"))]
            Self::Tauri(c) => c.pid(),
            #[cfg(feature = "mas")]
            Self::Native(n) => n.pid(),
        }
    }

    /// Consume the handle and kill the underlying process. Returns
    /// `io::Result` for both flavors — the DMG path adapts
    /// `tauri_plugin_shell::Error` via `io::Error::other`.
    pub fn kill(self) -> std::io::Result<()> {
        match self {
            #[cfg(not(feature = "mas"))]
            Self::Tauri(c) => c
                .kill()
                .map_err(|e| std::io::Error::other(e.to_string())),
            #[cfg(feature = "mas")]
            Self::Native(n) => n.kill(),
        }
    }
}

/// Resolve the absolute path to the helper binary inside the running .app
/// bundle. Computed from Tauri's resource_dir:
///   resource_dir   = `<bundle>/Contents/Resources/`
///   parent         = `<bundle>/Contents/`
///   helper binary  = `<bundle>/Contents/Helpers/Clauge Helper.app/Contents/MacOS/clauge-server`
///
/// Matches the layout produced by `scripts/build-mas-clean.sh` (helper.app
/// wrap step). Returns an error if `resource_dir` lookup fails or the path
/// has no parent (pathological, would mean Tauri returned `/`).
#[cfg(feature = "mas")]
fn resolve_helper_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir lookup failed: {}", e))?;
    let contents = resource_dir.parent().ok_or_else(|| {
        format!(
            "resource_dir has no parent: {}",
            resource_dir.display()
        )
    })?;
    Ok(contents
        .join("Helpers")
        .join("Clauge Helper.app")
        .join("Contents")
        .join("MacOS")
        .join("clauge-server"))
}

/// MAS spawn path: launch the helper via `tokio::process::Command` and
/// background two tokio tasks that forward (a) stderr lines as
/// `SidecarEvent::Stderr` and (b) process termination as
/// `SidecarEvent::Terminated`. Returns the unbuffered receiver plus a
/// `NativeChild` carrying only the PID (kill is libc::kill SIGTERM).
///
/// `kill_on_drop(true)` on the tokio Command guards against a panic in
/// the spawning task: if anything unwinds before the wait-task picks up
/// the Child, the kernel reaps the helper.
#[cfg(feature = "mas")]
async fn spawn_native_helper(
    helper_path: std::path::PathBuf,
) -> std::io::Result<(NativeChild, UnboundedReceiver<SidecarEvent>)> {
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    log::info!("Spawning MAS helper at: {}", helper_path.display());

    let mut cmd = tokio::process::Command::new(&helper_path);
    cmd.env("NO_OPEN", "1");
    // Forward the MAS-flavor CLAUDE_DIR if the parent has resolved a bookmark.
    // The DMG flavor spawns via Tauri's shell plugin `sidecar()`, which auto-
    // inherits the parent's env on spawn; `tokio::process::Command` does not
    // carry anything meaningful here, so the redirect target must be set
    // explicitly. `MAS_CLAUDE_DIR.set()` is called from BOTH the supervisor's
    // startup path (when a bookmark already exists) AND `grant_claude_dir_access`
    // (first-launch grant + Re-select folder), so reading `.get()` at spawn-time
    // picks up whichever populated it — including after a grant-and-respawn cycle.
    if let Some(claude_dir) = crate::security_scoped_bookmark::MAS_CLAUDE_DIR.get() {
        cmd.env("CLAUDE_DIR", claude_dir);
    }
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    cmd.stdin(Stdio::null());
    cmd.kill_on_drop(true);

    let mut child = cmd.spawn()?;
    let pid = child
        .id()
        .expect("freshly-spawned tokio Child must have a PID");
    let stderr = child
        .stderr
        .take()
        .expect("stderr is piped above so .take() yields Some");

    let (tx, rx) = unbounded_channel();

    // Stderr reader task: parse line-by-line and forward.
    let tx_stderr = tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if tx_stderr
                        .send(SidecarEvent::Stderr(line.into_bytes()))
                        .is_err()
                    {
                        // Receiver dropped — supervisor has moved on; stop reading.
                        break;
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
    });

    // Wait-for-termination task: emit Terminated once.
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => {
                let code = status.code();
                let signal = {
                    use std::os::unix::process::ExitStatusExt;
                    status.signal()
                };
                let _ = tx.send(SidecarEvent::Terminated { code, signal });
            }
            Err(e) => {
                log::warn!("native helper wait() failed: {}", e);
                let _ = tx.send(SidecarEvent::Terminated {
                    code: None,
                    signal: None,
                });
            }
        }
    });

    Ok((NativeChild { pid }, rx))
}

/// Cfg-gated spawn step. Returns the unified child + event receiver.
/// Both branches produce `(SidecarChild, UnboundedReceiver<SidecarEvent>)`,
/// so `spawn_one` above can be flavor-agnostic from this point on.
async fn spawn_helper_process(
    app: &AppHandle,
) -> Result<(SidecarChild, UnboundedReceiver<SidecarEvent>), String> {
    #[cfg(not(feature = "mas"))]
    {
        let (mut tauri_rx, tauri_child): (
            tauri::async_runtime::Receiver<CommandEvent>,
            CommandChild,
        ) = app
            .shell()
            .sidecar("clauge-server")
            .map_err(|e| e.to_string())?
            .env("NO_OPEN", "1")
            .spawn()
            .map_err(|e| e.to_string())?;

        // Bridge Tauri's CommandEvent stream → our SidecarEvent receiver.
        // Filters out Stdout / Error / IPC-injected events the supervisor
        // doesn't consume. One forwarding task lives per spawn; it exits
        // when the stream closes (Terminated arrives or sender drops).
        let (tx, rx) = unbounded_channel();
        tokio::spawn(async move {
            while let Some(ev) = tauri_rx.recv().await {
                let forwarded = match ev {
                    CommandEvent::Stderr(bytes) => Some(SidecarEvent::Stderr(bytes)),
                    CommandEvent::Terminated(payload) => Some(SidecarEvent::Terminated {
                        code: payload.code,
                        signal: payload.signal,
                    }),
                    // Stdout / Error / future variants are not load-bearing.
                    _ => None,
                };
                let is_terminated =
                    matches!(forwarded, Some(SidecarEvent::Terminated { .. }));
                if let Some(ev) = forwarded {
                    if tx.send(ev).is_err() {
                        break;
                    }
                }
                if is_terminated {
                    break;
                }
            }
        });

        Ok((SidecarChild::Tauri(tauri_child), rx))
    }

    #[cfg(feature = "mas")]
    {
        let helper_path = resolve_helper_path(app)?;
        let (native, rx) = spawn_native_helper(helper_path)
            .await
            .map_err(|e| format!("native helper spawn failed: {}", e))?;
        Ok((SidecarChild::Native(native), rx))
    }
}

/// v0.9.0 MAS (Task 12b): kill the current sidecar PID so the supervisor's
/// loop respawns it with the now-populated `MAS_CLAUDE_DIR` (`CLAUDE_DIR`
/// env). Called from `grant_claude_dir_access` IPC after first-launch
/// bookmark grant.
///
/// Sandbox-safe kill: route through AppState::take_all_children() +
/// CommandChild::kill() (same primitive `ipc::restart_app` uses). The
/// earlier port_discovery::kill_pid_on_port path shelled out to
/// /usr/sbin/lsof + /bin/kill — the App Sandbox blocks lsof (it needs
/// proc_info/sysctl calls the sandbox denies), making the kill a silent
/// no-op. CommandChild::kill() → SharedChild::kill() → libc::kill(), with
/// no external binary spawn and no entitlement change needed.
///
/// Supervisor (spawn_and_supervise) observes the child's Terminated event,
/// loops back to spawn_one, and the new sidecar inherits CLAUDE_DIR from
/// the now-populated MAS_CLAUDE_DIR.
#[cfg(feature = "mas")]
pub async fn kill_current_sidecar_for_respawn(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<crate::ipc::AppState>() else {
        log::warn!("kill_current_sidecar_for_respawn: AppState missing");
        return;
    };
    let children = state.take_all_children();
    if children.is_empty() {
        log::warn!("kill_current_sidecar_for_respawn: no registered sidecar children");
        return;
    }
    for child in children {
        let pid = child.pid();
        if let Err(e) = child.kill() {
            log::warn!(
                "kill_current_sidecar_for_respawn: kill pid={} failed: {}",
                pid,
                e
            );
        } else {
            log::info!(
                "kill_current_sidecar_for_respawn: killed pid={}; supervisor will respawn with fresh CLAUDE_DIR",
                pid
            );
        }
    }
}

/// Continuously runs the sidecar process, restarting on crash with exponential backoff.
/// On 3rd crash within 60s, emits a one-shot user notification.
///
/// Wired into Tauri's `setup()` lifecycle (T12). Loops forever:
///   1. Check `AppState::is_shutting_down()` — bail before spawning if quit
///      has been requested while we were in backoff or between phases.
///   2. Spawn child via `spawn_one`, capturing the bound port. The freshly
///      spawned `CommandChild` is REGISTERED with `AppState::children` so the
///      lib.rs `ExitRequested` hook can kill it directly even if this task
///      is mid-spawn or asleep when the quit fires.
///   3. Race `rx.recv()` against the shutdown signal. On natural termination
///      we unregister the child (so the registry doesn't grow unboundedly
///      across crash-respawn). On shutdown we just return — the lib.rs
///      handler will lock `children` and kill everything.
///   4. On crash: consult `CrashBreaker` for SilentRespawn / NotifyAndRespawn /
///      BackoffRespawn; notify the user if needed; sleep if backing off; loop.
///
/// **Process-lifetime contract (the orphan-sidecar bug — fixed in v0.3.1):**
/// `CommandChild` (and its inner `Arc<SharedChild>`) have **no** `Drop` impl,
/// so simply dropping a `CommandChild` binding does NOT kill the OS process.
///
/// Pre-v0.3.1, this was handled by giving the supervisor task a `child_slot:
/// Option<CommandChild>` and racing `rx.recv()` against `shutdown.notified()`.
/// That worked for the *currently-supervised* child, but missed two cases
/// observed during smoke testing of v0.3.0:
///   (a) Crash-respawn racing the quit signal: a fresh child spawned by the
///       circuit-breaker after the OLD one died was never visible to the
///       quit handler, so it survived the parent process exit.
///   (b) `notify_waiters()` is edge-triggered — if the supervisor was inside
///       `spawn_one()` (NOT awaiting `shutdown.notified()`) when the quit
///       fired, the wake-up was dropped and the supervisor kept running.
///
/// The fix: every spawned child registers with `AppState::children`, and the
/// supervisor polls `AppState::is_shutting_down()` between phases. The lib.rs
/// `ExitRequested` hook now seizes `take_all_children()` and kills each one,
/// bypassing the supervisor task entirely.
pub async fn spawn_and_supervise(app: AppHandle) {
    let mut breaker = CrashBreaker::new();

    // Snapshot the shared shutdown plumbing up front; if AppState is missing
    // we still run, just without graceful kill-on-exit. (No sensible fallback
    // — missing state means a misconfigured Tauri build, which surfaces in dev.)
    let state = app.try_state::<crate::ipc::AppState>();
    let shutdown_notify = state.as_ref().map(|s| s.shutdown.clone());

    /// Inline helper: did the user click Quit? Shared by the spawn-loop guard
    /// AND the backoff race below so the two checks stay in sync.
    fn quit_requested(state: &Option<tauri::State<crate::ipc::AppState>>) -> bool {
        state
            .as_ref()
            .map(|s| s.is_shutting_down())
            .unwrap_or(false)
    }

    // v0.9.0 MAS flavor: resolve the user-granted security-scoped bookmark to
    // ~/.claude (or wherever they pointed the picker) ONCE, before the spawn
    // loop. Hold the resulting `ScopedHandle` in a function-local for as long
    // as this function runs — when `spawn_and_supervise` returns on app exit,
    // `_mas_scope_guard` drops and `stopAccessingSecurityScopedResource` fires.
    //
    // Resolving once rather than per-spawn matters because:
    //   1. The bookmark blob doesn't change across crash-respawn cycles.
    //   2. Repeated `start...` calls without intervening `stop...` are not
    //      documented as additive — Apple's behavior is "the URL is in scope
    //      from start until stop"; second start may or may not be a no-op.
    //   3. The sidecar inherits the parent's security-scoped sandbox grant
    //      through the process tree (Apple's sandbox model), so as long as
    //      the parent holds the scope, every child it spawns inherits it.
    //
    // Critical lifetime contract: this binding MUST live for the entire
    // supervisor function — moving it inside the loop would drop the scope
    // between iterations and orphan in-flight sidecar reads. The leading `_`
    // silences "unused" warnings when the bookmark is absent (None case).
    //
    // If the bookmark is missing or stale (user hasn't completed the wizard's
    // grant step yet, or the persisted blob no longer resolves), we log and
    // proceed. The sidecar will see filesystem ENOENT/EPERM when it reads
    // JSONL inside the sandbox and surface empty data; the wizard's grant
    // step is the recovery path.
    #[cfg(feature = "mas")]
    let _mas_scope_guard = {
        use crate::security_scoped_bookmark::{acquire_scoped_path, MAS_CLAUDE_DIR};
        match acquire_scoped_path(&app) {
            Ok((path, guard)) => {
                // Populate MAS_CLAUDE_DIR so keychain.rs's MAS branch can find
                // .credentials.json without `&AppHandle` in its zero-arg
                // signature. `OnceLock::set` is idempotent — `Err` here means
                // another caller raced and won, which we don't care about
                // because both code paths resolve to the same bookmark blob
                // and would set identical values.
                let _ = MAS_CLAUDE_DIR.set(std::path::PathBuf::from(&path));
                log::info!(
                    "MAS flavor: security-scoped CLAUDE_DIR resolved at {}",
                    path
                );
                Some(guard)
            }
            Err(e) => {
                log::warn!(
                    "MAS bookmark not yet granted: {}. Sidecar will start with CLAUDE_DIR=$HOME/.claude (sandbox-redirected to container subfolder, expected to be empty); user must grant via wizard step 2 or Settings → Connections.",
                    e
                );
                None
            }
        }
    };

    loop {
        // Level-triggered guard: covers the case where ExitRequested fired
        // while we were sleeping in BackoffRespawn or between phases. Without
        // this, the supervisor would happily spawn a fresh child AFTER quit.
        if quit_requested(&state) {
            log::info!("Shutdown flag set; supervisor exiting before next spawn");
            return;
        }

        match spawn_one(&app, shutdown_notify.as_deref()).await {
            Ok((port, mut rx, child)) => {
                let pid = child.pid();
                log::info!("Sidecar bound to port {} (pid={})", port, pid);
                if let Some(ref s) = state {
                    if let Err(e) = s.set_port(port) {
                        log::error!("Failed to record sidecar port: {}", e);
                    }
                    // Tell the native popover to (re)load — the WKWebView
                    // was created with whatever port AppState held at boot,
                    // which may have been the default-fallback before the
                    // sidecar actually bound.
                    crate::native_popover::reload_for_port(&app, port);
                    // Register the child BEFORE entering the supervise loop.
                    // If the user hits Cmd+Q at this exact moment, the
                    // ExitRequested handler will see this PID in
                    // AppState::children and kill it — no race window.
                    s.register_child(child);
                } else {
                    // No AppState: the OS process will be leaked on quit.
                    // Drop the child handle here so we don't carry it into
                    // the supervise loop (we no longer need it for kill).
                    drop(child);
                }

                // v0.8.1: emit `sidecar-ready` Tauri event AFTER set_port so
                // the splash window's on_navigation handler reads the correct
                // live port. Splash uses this as its primary trigger; absent
                // the event it falls back to polling get_server_port IPC.
                {
                    use tauri::Emitter;
                    if let Err(e) = app.emit("sidecar-ready", serde_json::json!({ "port": port })) {
                        log::warn!("Failed to emit sidecar-ready event: {}", e);
                    }
                }

                if let Some(ref n) = shutdown_notify {
                    loop {
                        tokio::select! {
                            biased;
                            _ = n.notified() => {
                                log::info!(
                                    "Shutdown requested while supervising pid={}; lib.rs will kill",
                                    pid
                                );
                                // Don't unregister — we WANT lib.rs's
                                // take_all_children() to find this PID and
                                // kill the process.
                                return;
                            }
                            ev = rx.recv() => match ev {
                                Some(SidecarEvent::Terminated { code, signal }) => {
                                    log::warn!(
                                        "Sidecar terminated naturally (pid={}, code={:?}, signal={:?})",
                                        pid, code, signal
                                    );
                                    // Natural exit: the OS process is gone.
                                    // Unregister so AppState::children doesn't
                                    // grow unboundedly across crash cycles.
                                    if let Some(ref s) = state {
                                        s.unregister_child(pid);
                                    }
                                    break;
                                }
                                Some(SidecarEvent::Stderr(_)) => {} // ignore post-bound stderr
                                None => {
                                    log::warn!("Sidecar event stream closed (pid={})", pid);
                                    if let Some(ref s) = state {
                                        s.unregister_child(pid);
                                    }
                                    break;
                                }
                            }
                        }
                    }
                } else {
                    // AppState missing — degraded path. We can't observe the
                    // shutdown signal, but we still drain the event stream so
                    // the crash breaker fires.
                    while let Some(ev) = rx.recv().await {
                        if let SidecarEvent::Terminated { code, signal } = ev {
                            log::warn!(
                                "Sidecar terminated (pid={}, code={:?}, signal={:?})",
                                pid, code, signal
                            );
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("Sidecar spawn failed: {}", e);
            }
        }

        // Re-check the shutdown flag before the crash breaker decides whether
        // to respawn. Without this, a crash that races with Cmd+Q would push
        // the supervisor through a notify+backoff cycle and possibly spawn
        // another child before the next loop guard fires.
        if quit_requested(&state) {
            log::info!("Shutdown flag set after termination; supervisor exiting");
            return;
        }

        let action = breaker.record(Instant::now());
        log::warn!("Sidecar respawn action: {:?}", action);
        match action {
            CrashAction::SilentRespawn => {}
            CrashAction::NotifyAndRespawn => {
                use tauri_plugin_notification::NotificationExt;
                if let Err(e) = app
                    .notification()
                    .builder()
                    .title("Clauge")
                    .body("Clauge had a problem — please restart the app.")
                    .show()
                {
                    log::error!("Failed to dispatch crash notification: {}", e);
                }
            }
            CrashAction::BackoffRespawn(d) => {
                // Race the backoff against shutdown so a quit during backoff
                // doesn't leave the supervisor task napping past app exit.
                if let Some(ref n) = shutdown_notify {
                    tokio::select! {
                        _ = n.notified() => {
                            log::info!("Shutdown during backoff; not respawning");
                            return;
                        }
                        _ = tokio::time::sleep(d) => {}
                    }
                } else {
                    tokio::time::sleep(d).await;
                }
            }
        }
    }
}

/// Spawn the sidecar binary once and wait for it to report its bound port via
/// `CLAUGE_BOUND_PORT=<n>` on stderr. Returns the port plus the live event stream
/// and child handle so the caller can detect termination.
///
/// Optionally takes a `shutdown_notify` so the port-discovery wait can be
/// interrupted if the user quits before the sidecar finishes binding. Without
/// this, a Cmd+Q during the (typically 100–500ms) startup window would race —
/// the supervisor would still be inside this `await rx.recv()` when the
/// ExitRequested handler fired, leaving the half-spawned process around. By
/// killing the child here when shutdown is signaled, we cover the gap before
/// `register_child` runs in the parent loop.
async fn spawn_one(
    app: &AppHandle,
    shutdown_notify: Option<&tokio::sync::Notify>,
) -> Result<(u16, UnboundedReceiver<SidecarEvent>, SidecarChild), String> {
    // Spawn via the cfg-gated wrapper:
    //   - DMG: Tauri shell plugin sidecar() at Contents/MacOS/clauge-server
    //   - MAS: tokio::process::Command at
    //          Contents/Helpers/Clauge Helper.app/Contents/MacOS/clauge-server
    // Both paths return the same unified types. NO_OPEN=1 (suppressing
    // server.js's `open(url)` default-browser pop) is set inside the
    // spawn helpers so both flavors get it. v0.3.0 smoke test Bug #3
    // tracked the "Open Dashboard opens in Chrome" regression to this.
    let (child, mut rx) = spawn_helper_process(app).await?;

    // Park the child in an Option so the shutdown branch can `take()` and
    // call the consuming `kill(self)`. Same pattern as the supervise loop.
    let mut child_slot: Option<SidecarChild> = Some(child);

    loop {
        if let Some(notify) = shutdown_notify {
            tokio::select! {
                biased;
                _ = notify.notified() => {
                    if let Some(c) = child_slot.take() {
                        log::info!("Shutdown during sidecar startup; killing pid={}", c.pid());
                        if let Err(e) = c.kill() {
                            log::error!("Failed to kill half-spawned sidecar: {}", e);
                        }
                    }
                    return Err("shutdown requested before port marker".to_string());
                }
                ev = rx.recv() => {
                    if let Some(result) = handle_event(ev, &mut child_slot) {
                        // result is Some when we either got the port OR hit a
                        // terminal condition (process died, stream closed).
                        match result {
                            Ok(port) => {
                                let child = child_slot.take().expect("port marker without child");
                                return Ok((port, rx, child));
                            }
                            Err(e) => return Err(e),
                        }
                    }
                }
            }
        } else {
            let ev = rx.recv().await;
            if let Some(result) = handle_event(ev, &mut child_slot) {
                match result {
                    Ok(port) => {
                        let child = child_slot.take().expect("port marker without child");
                        return Ok((port, rx, child));
                    }
                    Err(e) => return Err(e),
                }
            }
        }
    }
}

/// Inspect a single SidecarEvent; return:
///   - `Some(Ok(port))` if a `CLAUGE_BOUND_PORT=` line was parsed (caller
///     should extract the child)
///   - `Some(Err(msg))` if the process died or the stream closed
///   - `None` for ignored events (caller should keep awaiting)
fn handle_event(
    ev: Option<SidecarEvent>,
    _child_slot: &mut Option<SidecarChild>,
) -> Option<Result<u16, String>> {
    match ev {
        Some(SidecarEvent::Stderr(line_bytes)) => {
            let line = String::from_utf8_lossy(&line_bytes);
            if let Some(idx) = line.find(PORT_MARKER) {
                let after = &line[idx + PORT_MARKER.len()..];
                if let Some(port_str) = after.split_whitespace().next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        return Some(Ok(port));
                    }
                }
            }
            None
        }
        Some(SidecarEvent::Terminated { code, signal }) => Some(Err(format!(
            "sidecar exited before binding port (code={:?}, signal={:?})",
            code, signal
        ))),
        None => Some(Err(
            "sidecar event stream closed before port marker".to_string()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(secs: u64) -> Instant {
        // Use a fixed reference for tests
        static REF: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        let r = REF.get_or_init(Instant::now);
        *r + Duration::from_secs(secs)
    }

    #[test]
    fn first_crash_is_silent() {
        let mut b = CrashBreaker::new();
        assert_eq!(b.record(t(0)), CrashAction::SilentRespawn);
    }

    #[test]
    fn second_crash_within_60s_is_silent() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        assert_eq!(b.record(t(30)), CrashAction::SilentRespawn);
    }

    #[test]
    fn third_crash_within_60s_notifies() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(20));
        assert_eq!(b.record(t(40)), CrashAction::NotifyAndRespawn);
    }

    #[test]
    fn fourth_crash_within_60s_backs_off() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(10));
        b.record(t(20));
        let r = b.record(t(30));
        assert!(matches!(r, CrashAction::BackoffRespawn(d) if d == Duration::from_secs(2)));
    }

    #[test]
    fn fifth_crash_uses_4s_backoff() {
        let mut b = CrashBreaker::new();
        for i in 0..4 {
            b.record(t(i * 5));
        }
        let r = b.record(t(25));
        assert!(matches!(r, CrashAction::BackoffRespawn(d) if d == Duration::from_secs(4)));
    }

    #[test]
    fn sixth_crash_caps_backoff_at_8s() {
        let mut b = CrashBreaker::new();
        for i in 0..5 {
            b.record(t(i * 5));
        }
        let r = b.record(t(30));
        assert!(matches!(r, CrashAction::BackoffRespawn(d) if d == Duration::from_secs(8)));
    }

    #[test]
    fn crashes_outside_window_are_dropped() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(10));
        b.record(t(20));
        // 90 seconds later: previous crashes should be pruned
        assert_eq!(b.record(t(110)), CrashAction::SilentRespawn);
    }

    #[test]
    fn notification_does_not_repeat_within_same_window() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(10));
        b.record(t(20)); // notify
                         // 4th crash → backoff, NOT a second notification
        let r = b.record(t(30));
        assert!(matches!(r, CrashAction::BackoffRespawn(_)));
        assert!(b.was_notified());
    }

    #[test]
    fn notification_fires_again_in_new_window() {
        let mut b = CrashBreaker::new();
        // Window 1: 3 crashes → notify
        b.record(t(0));
        b.record(t(10));
        assert_eq!(b.record(t(20)), CrashAction::NotifyAndRespawn);
        assert!(b.was_notified());

        // Long pause: window empties (>60s after the LAST crash at t(20))
        // First crash in new window: t(81 + 0) — well clear of t(20) + 60s = t(80)
        // The empty-deque check inside record() should reset notification_sent.
        b.record(t(81));
        b.record(t(85));
        // 3rd crash in new window — should NOTIFY AGAIN
        assert_eq!(b.record(t(90)), CrashAction::NotifyAndRespawn);
    }

    #[test]
    fn crash_at_exact_60s_boundary_keeps_prior_entry() {
        let mut b = CrashBreaker::new();
        b.record(t(0)); // len=1
        b.record(t(30)); // len=2 → silent
                         // 3rd crash exactly 60s after the FIRST one
                         // t(0) is at the strict-> boundary — should still be retained
                         // → 3rd crash → notify (proves the first entry wasn't pruned)
        assert_eq!(b.record(t(60)), CrashAction::NotifyAndRespawn);
    }
}
