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
                let action = if self.notification_sent {
                    CrashAction::SilentRespawn
                } else {
                    self.notification_sent = true;
                    CrashAction::NotifyAndRespawn
                };
                action
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
pub enum CrashAction {
    SilentRespawn,
    NotifyAndRespawn,
    /// Respawn after a delay. Schedule for crashes 4..=N within the window:
    /// 2s, 4s, 8s, 8s, 8s, ... (capped at 8s).
    BackoffRespawn(Duration),
}

use tauri::{AppHandle, Manager};
use tauri::async_runtime::Receiver;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const PORT_MARKER: &str = "CLAUGE_BOUND_PORT=";

/// v0.9.0 MAS (Task 12b): kill the current sidecar PID so the supervisor's
/// loop respawns it with the now-populated `MAS_CLAUDE_DIR` (`CLAUDE_DIR`
/// env). Called from `grant_claude_dir_access` IPC after first-launch
/// bookmark grant.
///
/// **Why this is the right primitive:** the supervisor loop already
/// auto-respawns on sidecar death (that's the whole `CrashBreaker` machinery
/// above), so we just need to terminate the OS process to trigger the loop.
/// We reuse the existing `port_discovery::kill_pid_on_port(3456)` shell-out
/// (`lsof -i :3456 -t` + `kill -9`) rather than introducing a second kill
/// path — same primitive, well-tested via the orphan-eviction flow.
///
/// **MAS sandbox caveat:** `lsof` and `kill` are system binaries
/// (`/usr/bin/lsof` + `/bin/kill`). Apple's App Sandbox sometimes blocks
/// system-binary spawns without a `temporary-exception.spawn` entitlement.
/// If this turns out to fail on the App Store build, fallback is to track
/// the sidecar's `CommandChild` handle in `AppState::children` and call
/// `kill()` on it directly. The current implementation favors the simpler
/// path because `kill_pid_on_port` is already used by the orphan-eviction
/// flow on every cold start (verified working pre-Task 12); if the sandbox
/// blocks it, that flow would have already failed.
#[cfg(feature = "mas")]
pub async fn kill_current_sidecar_for_respawn(app: &tauri::AppHandle) {
    // Sandbox-safe kill: route through AppState::take_all_children() +
    // CommandChild::kill() (same primitive ipc::restart_app uses). The
    // earlier port_discovery::kill_pid_on_port path shelled out to
    // /usr/sbin/lsof + /bin/kill — the App Sandbox blocks lsof (it needs
    // proc_info/sysctl calls the sandbox denies), making the kill a silent
    // no-op. CommandChild::kill() → SharedChild::kill() → libc::kill(), with
    // no external binary spawn and no entitlement change needed.
    //
    // Supervisor (spawn_and_supervise below) observes the child's
    // Terminated event, loops back to spawn_one, and the new sidecar
    // inherits CLAUDE_DIR from the now-populated MAS_CLAUDE_DIR.
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
        state.as_ref().map(|s| s.is_shutting_down()).unwrap_or(false)
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
                    if let Err(e) = app.emit(
                        "sidecar-ready",
                        serde_json::json!({ "port": port }),
                    ) {
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
                                Some(CommandEvent::Terminated(payload)) => {
                                    log::warn!(
                                        "Sidecar terminated naturally (pid={}, code={:?}, signal={:?})",
                                        pid,
                                        payload.code,
                                        payload.signal
                                    );
                                    // Natural exit: the OS process is gone.
                                    // Unregister so AppState::children doesn't
                                    // grow unboundedly across crash cycles.
                                    if let Some(ref s) = state {
                                        s.unregister_child(pid);
                                    }
                                    break;
                                }
                                Some(_) => {} // ignore stdout/stderr/error noise
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
                        if let CommandEvent::Terminated(payload) = ev {
                            log::warn!(
                                "Sidecar terminated (pid={}, code={:?}, signal={:?})",
                                pid,
                                payload.code,
                                payload.signal
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
) -> Result<(u16, Receiver<CommandEvent>, CommandChild), String> {
    // NO_OPEN=1 suppresses server.js's `open(url)` call (server.js:594) which
    // otherwise pops the user's default browser to http://localhost:<port>
    // on every sidecar startup. Without this, every Clauge.app launch — and
    // every crash-respawn — opens a fresh Chrome tab on top of the user's
    // workspace. v0.3.0 manual smoke test reported this as Bug #3 ("Open
    // Dashboard opens in system browser instead of Tauri webview"); the
    // popover's Open Dashboard button was correctly creating a Tauri
    // webview, but the sidecar's auto-open was racing the user and they
    // saw Chrome appear first.
    //
    // v0.9.0 MAS flavor: forward the resolved CLAUDE_DIR from the
    // security-scoped bookmark down to the child. server.js:40 already
    // honors $CLAUDE_DIR as the parent of `projects/`. We read from the
    // process-wide MAS_CLAUDE_DIR OnceLock that spawn_and_supervise
    // populates BEFORE entering this loop, so by the time we get here the
    // value is either set (bookmark resolved) or unset (user hasn't granted
    // yet — sidecar runs with its default $HOME/.claude, which the sandbox
    // redirects to the container subfolder and is expected to be empty).
    //
    // DMG flavor: no CLAUDE_DIR env set — server.js:40 falls back to
    // $HOME/.claude on its own, which is the right value outside a sandbox.
    let claude_dir_env: Option<String> = {
        #[cfg(feature = "mas")]
        {
            crate::security_scoped_bookmark::MAS_CLAUDE_DIR
                .get()
                .map(|p| p.to_string_lossy().into_owned())
        }
        #[cfg(not(feature = "mas"))]
        {
            None
        }
    };

    let mut builder = app
        .shell()
        .sidecar("clauge-server")
        .map_err(|e| e.to_string())?
        .env("NO_OPEN", "1");
    if let Some(dir) = &claude_dir_env {
        builder = builder.env("CLAUDE_DIR", dir);
    }
    let (mut rx, child): (Receiver<CommandEvent>, CommandChild) =
        builder.spawn().map_err(|e| e.to_string())?;

    // Park the child in an Option so the shutdown branch can `take()` and
    // call the consuming `kill(self)`. Same pattern as the supervise loop.
    let mut child_slot: Option<CommandChild> = Some(child);

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

/// Inspect a single CommandEvent; return:
///   - `Some(Ok(port))` if a `CLAUGE_BOUND_PORT=` line was parsed (caller should
///     extract the child)
///   - `Some(Err(msg))` if the process died or the stream closed
///   - `None` for ignored events (caller should keep awaiting)
fn handle_event(
    ev: Option<CommandEvent>,
    _child_slot: &mut Option<CommandChild>,
) -> Option<Result<u16, String>> {
    match ev {
        Some(CommandEvent::Stderr(line_bytes)) => {
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
        Some(CommandEvent::Terminated(payload)) => Some(Err(format!(
            "sidecar exited before binding port (code={:?}, signal={:?})",
            payload.code, payload.signal
        ))),
        Some(_) => None, // ignore stdout / error noise
        None => Some(Err("sidecar event stream closed before port marker".to_string())),
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
