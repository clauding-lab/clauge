//! Shared timeout-bearing reqwest client for parent → sidecar loopback HTTP.
//!
//! v1.2.0: bare `reqwest::get` has NO default timeout, so a single hung
//! loopback connection could wedge the tray-percent poller and the iCloud
//! publish loop forever (both are single-threaded loops). Every parent-side
//! loopback call shares this client; per-request `.timeout(...)` overrides
//! keep the health probe (2s) and port probe (1s) as tight as before.
//! Mirrors the OAUTH_CLIENT pattern in anthropic_oauth.rs.

use once_cell::sync::Lazy;
use std::time::Duration;

/// Default timeout for loopback calls. Generous for 127.0.0.1, but bounded —
/// a wedged sidecar response must never hang a poll loop.
pub const LOCAL_HTTP_TIMEOUT: Duration = Duration::from_secs(5);

pub static LOCAL_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(LOCAL_HTTP_TIMEOUT)
        .user_agent(concat!("Clauge/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest::Client::build is infallible without a custom config")
});

#[cfg(test)]
mod tests {
    use super::*;

    /// A TCP listener that accepts and never responds — the shape of a
    /// wedged sidecar. The 200ms per-request override keeps the test fast;
    /// the assertion is reqwest's timeout classification.
    #[tokio::test]
    async fn local_client_times_out_on_unresponsive_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let port = listener.local_addr().expect("local_addr").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                // Hold each connection open without writing a byte.
                std::mem::forget(stream);
            }
        });
        let err = LOCAL_CLIENT
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .timeout(Duration::from_millis(200))
            .send()
            .await
            .expect_err("never-responding socket must time out");
        assert!(err.is_timeout(), "expected timeout, got: {err:?}");
    }
}
