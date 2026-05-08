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

/// Continuously runs the sidecar process, restarting on crash with exponential backoff.
/// On 3rd crash within 60s, emits a one-shot user notification.
///
/// Wired into Tauri's `setup()` lifecycle (T12). Loops forever:
///   1. Spawn child via `spawn_one`, capturing the bound port.
///   2. Race `rx.recv()` against the shutdown signal — break on either crash
///      or shutdown.
///   3. On shutdown: explicitly call `child.kill()` and return immediately,
///      bypassing the crash breaker entirely.
///   4. On crash: consult `CrashBreaker` for SilentRespawn / NotifyAndRespawn /
///      BackoffRespawn; notify the user if needed; sleep if backing off; loop.
///
/// **Process-lifetime contract (the orphan-sidecar bug):**
/// `CommandChild` (and its inner `Arc<SharedChild>`) have **no** `Drop` impl,
/// so simply dropping the `child` binding does NOT kill the OS process. Without
/// the explicit `child.kill()` below — driven by `RunEvent::ExitRequested` in
/// `lib.rs` notifying `state.shutdown` — every app launch/quit cycle would leak
/// a `clauge-server` process. The child is held in scope alongside `rx` so the
/// underlying file descriptors stay live and `CommandEvent::Terminated` can
/// be observed; nothing more.
pub async fn spawn_and_supervise(app: AppHandle) {
    let mut breaker = CrashBreaker::new();

    // Snapshot the shutdown signal up front; if AppState is missing we still
    // run, just without graceful kill-on-exit (no fallback path is sensible —
    // missing state means a misconfigured Tauri build, which surfaces in dev).
    let shutdown = app
        .try_state::<crate::ipc::AppState>()
        .map(|s| s.shutdown.clone());

    loop {
        match spawn_one(&app).await {
            Ok((port, mut rx, child)) => {
                log::info!("Sidecar bound to port {} (pid={})", port, child.pid());
                if let Some(state) = app.try_state::<crate::ipc::AppState>() {
                    if let Err(e) = state.set_port(port) {
                        log::error!("Failed to record sidecar port: {}", e);
                    }
                }

                // Hold `child` in an Option so the shutdown branch can `take()`
                // it and call the consuming `kill(self)` while we still own the
                // event-loop frame. Without this, the binding would be dropped
                // at scope exit — and since CommandChild has NO Drop impl, that
                // drop does nothing to the OS process.
                let mut child_slot: Option<CommandChild> = Some(child);

                if let Some(ref s) = shutdown {
                    loop {
                        tokio::select! {
                            biased;
                            _ = s.notified() => {
                                log::info!("Shutdown requested; killing sidecar");
                                if let Some(c) = child_slot.take() {
                                    if let Err(e) = c.kill() {
                                        log::error!("Failed to kill sidecar: {}", e);
                                    }
                                }
                                return;
                            }
                            ev = rx.recv() => match ev {
                                Some(CommandEvent::Terminated(payload)) => {
                                    log::warn!(
                                        "Sidecar terminated (code={:?}, signal={:?})",
                                        payload.code,
                                        payload.signal
                                    );
                                    break;
                                }
                                Some(_) => {} // ignore stdout/stderr/error noise
                                None => {
                                    log::warn!("Sidecar event stream closed");
                                    break;
                                }
                            }
                        }
                    }
                } else {
                    // AppState missing — fall back to plain drain. At quit
                    // we'd leak, but this branch should never hit in a real
                    // Tauri build (setup() always registers AppState).
                    while let Some(ev) = rx.recv().await {
                        if let CommandEvent::Terminated(payload) = ev {
                            log::warn!(
                                "Sidecar terminated (code={:?}, signal={:?})",
                                payload.code,
                                payload.signal
                            );
                            break;
                        }
                    }
                }

                // child_slot may still hold a CommandChild if the loop broke
                // on Terminated; dropping it is a no-op (no Drop impl) — the
                // OS process is already gone in that path, so it's fine.
                drop(child_slot);
            }
            Err(e) => {
                log::error!("Sidecar spawn failed: {}", e);
            }
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
                if let Some(ref s) = shutdown {
                    tokio::select! {
                        _ = s.notified() => {
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
async fn spawn_one(
    app: &AppHandle,
) -> Result<(u16, Receiver<CommandEvent>, CommandChild), String> {
    let (mut rx, child): (Receiver<CommandEvent>, CommandChild) = app
        .shell()
        .sidecar("clauge-server")
        .map_err(|e| e.to_string())?
        .spawn()
        .map_err(|e| e.to_string())?;

    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stderr(line_bytes) => {
                let line = String::from_utf8_lossy(&line_bytes);
                if let Some(idx) = line.find(PORT_MARKER) {
                    let after = &line[idx + PORT_MARKER.len()..];
                    if let Some(port_str) = after.split_whitespace().next() {
                        if let Ok(port) = port_str.parse::<u16>() {
                            return Ok((port, rx, child));
                        }
                    }
                }
            }
            CommandEvent::Terminated(payload) => {
                return Err(format!(
                    "sidecar exited before binding port (code={:?}, signal={:?})",
                    payload.code, payload.signal
                ));
            }
            _ => {}
        }
    }
    Err("sidecar event stream closed before port marker".to_string())
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
