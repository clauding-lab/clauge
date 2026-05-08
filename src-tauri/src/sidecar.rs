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
