//! Port discovery for the clauge-server sidecar.
//!
//! Probes 127.0.0.1:3456/api/health and decides whether to share an existing
//! clauge-server (External) or spawn a fresh one (SpawnAt). The probe verifies
//! the response body's `service` field equals "clauge" so we don't mistake an
//! unrelated local service on the same port for our sidecar.

use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveryResult {
    External(u16),
    SpawnAt(u16),
}

#[derive(Deserialize)]
struct HealthBody {
    service: String,
}

pub async fn probe(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<HealthBody>().await {
                Ok(body) => body.service == "clauge",
                Err(_) => false,
            }
        }
        _ => false,
    }
}

pub async fn discover() -> DiscoveryResult {
    if probe(3456).await {
        DiscoveryResult::External(3456)
    } else {
        DiscoveryResult::SpawnAt(3456)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    #[tokio::test]
    async fn probe_returns_false_when_no_server() {
        assert!(!probe(45678).await);
    }

    #[tokio::test]
    async fn probe_returns_true_for_clauge_response() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/api/health")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"service":"clauge","version":"0.3.0","pid":1}"#)
            .create_async()
            .await;
        let url = server.url();
        let port: u16 = url.rsplit(':').next().unwrap().parse().unwrap();
        assert!(probe(port).await);
    }

    #[tokio::test]
    async fn probe_returns_false_for_non_clauge_service() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/api/health")
            .with_status(200)
            .with_body(r#"{"service":"something-else"}"#)
            .create_async()
            .await;
        let port: u16 = server.url().rsplit(':').next().unwrap().parse().unwrap();
        assert!(!probe(port).await);
    }
}
