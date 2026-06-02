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

/// Probe a port for an existing clauge-server. Returns `true` iff
/// `/api/health` answers 200 with a parseable JSON body whose `service`
/// field equals `"clauge"`. Thin wrapper over `probe_with_body(port)` —
/// kept as a named alias so call sites that don't need the response body
/// read cleanly. (v0.8.1 dedup: was a near-duplicate of probe_with_body's
/// body; same network/JSON contract, only the return type collapses
/// `Option<String>` → `bool`.)
///
/// Currently only exercised by the unit tests below; `discover_with_retry`
/// switched to `probe_with_body` in v0.7.3 to read the version field. Kept
/// `pub` as a stable boolean-probe shorthand for future callers.
#[allow(dead_code)]
pub async fn probe(port: u16) -> bool {
    probe_with_body(port).await.is_some()
}

/// Same probe as `probe()`, but returns the response body string when the
/// service identifies as "clauge" so callers can parse additional fields
/// (e.g., the `version` field for cold-launch self-heal). Returns `None`
/// on any failure mode `probe` would have returned `false` for.
///
/// We re-parse the body in `version_matches_self` rather than taking the
/// already-parsed `HealthBody`; the cost is one extra JSON parse, but the
/// helper stays a pure function that accepts any string for unit testing.
async fn probe_with_body(port: u16) -> Option<String> {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .ok()?;
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    let parsed: HealthBody = serde_json::from_str(&text).ok()?;
    if parsed.service != "clauge" {
        return None;
    }
    Some(text)
}

/// Compare a `/api/health` response body's `version` field to the Tauri
/// shell's compile-time version. Returns `true` iff the body parses, has a
/// `version` string field, and that field exactly equals
/// `env!("CARGO_PKG_VERSION")`.
///
/// Three failure modes (malformed JSON, missing field, mismatched value)
/// all return `false`. The compile-time `env!` guarantees the comparison
/// is against THIS Tauri shell's version, not whatever the running sidecar
/// claims to be.
fn version_matches_self(health_response: &str) -> bool {
    let v: serde_json::Value = match serde_json::from_str(health_response) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let server_version = match v.get("version").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return false,
    };
    server_version == env!("CARGO_PKG_VERSION")
}

/// Whether to adopt an already-running EXTERNAL sidecar instead of spawning our
/// own. Release builds NEVER adopt: a port-squatter can forge the public version
/// string and serve impostor content into a privileged webview (see the v1.0.0
/// security spec). Set `CLAUGE_ALLOW_EXTERNAL=1` to re-enable adoption for local
/// dev (e.g. a hand-run `node server.js`); the version check still gates it.
fn should_adopt_external(health_response: &str, allow_external: bool) -> bool {
    allow_external && version_matches_self(health_response)
}

/// Find any PIDs listening on the given TCP port and kill them with SIGKILL.
///
/// macOS: walks `libproc::proc_pid::listpids` and, for each PID, enumerates
/// its FDs via `libproc::proc_pid::listpidinfo::<ListFDs>` and inspects each
/// socket FD via `libproc::file_info::pidfdinfo::<SocketFDInfo>`. When a TCP
/// socket's local port matches, issues `libc::kill(pid, SIGKILL)`.
/// This avoids the App Sandbox–blocked `/usr/sbin/lsof` shell-out (the
/// sandbox denies the `proc_info`/`sysctl` calls lsof relies on, so the old
/// shell-out silently no-op'd inside the MAS build and orphan sidecars
/// survived).
///
/// Other Unix (Linux, BSD): keeps the legacy `lsof -i :PORT -t` + `kill -9`
/// shell-out — libproc is macOS-specific. If we ever ship a Linux build the
/// proper replacement is /proc/$pid/net/tcp parsing; tracked as future work.
///
/// Windows: parses `netstat -ano` for LISTENING rows on the given port,
/// then `taskkill /F /PID <pid>` for each.
///
/// Errors only on platform primitive failures (libproc enumeration, `lsof`
/// or `netstat` spawn). Per-PID failures (process already dead, owned by
/// another user we can't signal) are silently ignored — the post-condition
/// is "port is free", and we tolerate races where the process exited on its
/// own.
///
/// Sleeps 300 ms after the kill attempts to let the OS release the port.
async fn kill_pid_on_port(port: u16) -> Result<(), String> {
    #[cfg(unix)]
    {
        kill_pid_on_port_unix(port).await
    }
    #[cfg(windows)]
    {
        kill_pid_on_port_windows(port).await
    }
}

/// macOS path: libproc + libc::kill. Sandbox-safe — no subprocess spawn.
///
/// Algorithm:
/// 1. Enumerate all user-visible PIDs via `pids_by_type(ProcFilter::All)`.
/// 2. For each PID, ask libproc for its FD count (`pidinfo::<BSDInfo>`) and
///    then list all FDs (`listpidinfo::<ListFDs>`). Both calls can fail with
///    `EPERM` for PIDs owned by other users — we silently skip those.
/// 3. For each socket FD, fetch `SocketFDInfo` via `pidfdinfo` and check if
///    it's a TCP socket with `psi.soi_kind == Tcp` whose local port matches.
/// 4. On match: `unsafe { libc::kill(pid, SIGKILL) }`.
///
/// The `unsafe` block is required because `socket.psi.soi_proto` is a C
/// union (libproc mirrors XNU's `socket_info` layout 1:1), and accessing
/// `.pri_tcp` requires the caller to vouch for the discriminant
/// (`soi_kind`). We just verified `soi_kind == Tcp`, so this is sound.
///
/// `insi_lport` is stored in network byte order as an `i32` (libproc's FFI
/// width). We mask to the low 16 bits and byte-swap manually.
#[cfg(target_os = "macos")]
async fn kill_pid_on_port_unix(port: u16) -> Result<(), String> {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::file_info::{pidfdinfo, ListFDs, ProcFDType};
    use libproc::libproc::net_info::{SocketFDInfo, SocketInfoKind};
    use libproc::libproc::proc_pid::{listpidinfo, pidinfo};
    use libproc::processes::{pids_by_type, ProcFilter};

    let pids = pids_by_type(ProcFilter::All)
        .map_err(|e| format!("libproc pids_by_type(All) failed: {}", e))?;

    let mut killed_any = false;
    for raw_pid in pids {
        let pid = raw_pid as i32;

        // Step 1: get the BSD info for this PID so we know how many FDs to
        // ask for. Skip on permission error — PIDs owned by other users
        // return EPERM here, which is expected and not fatal.
        let bsd_info = match pidinfo::<BSDInfo>(pid, 0) {
            Ok(info) => info,
            Err(_) => continue,
        };

        // Step 2: list all FDs for this PID, bounded by pbi_nfiles.
        let fds = match listpidinfo::<ListFDs>(pid, bsd_info.pbi_nfiles as usize) {
            Ok(fds) => fds,
            Err(_) => continue,
        };

        for fd in fds {
            // ProcFDType implements From<u32>; filter socket FDs.
            if !matches!(fd.proc_fdtype.into(), ProcFDType::Socket) {
                continue;
            }

            // Step 3: fetch socket info. EPERM/EBADF can race (FD closed
            // between listpidinfo and pidfdinfo) — skip silently.
            let socket = match pidfdinfo::<SocketFDInfo>(pid, fd.proc_fd) {
                Ok(s) => s,
                Err(_) => continue,
            };

            // Filter to TCP sockets only.
            if !matches!(socket.psi.soi_kind.into(), SocketInfoKind::Tcp) {
                continue;
            }

            // SAFETY: we verified soi_kind == Tcp above, which is the
            // discriminant for the soi_proto union's pri_tcp variant.
            let tcp = unsafe { socket.psi.soi_proto.pri_tcp };

            // insi_lport is network-endian, stored in the low 16 bits of an
            // i32. Manual byteswap mirrors libproc's own doctest.
            let raw = tcp.tcpsi_ini.insi_lport;
            let local_port: u16 = (((raw >> 8) & 0x00ff) | ((raw << 8) & 0xff00)) as u16;

            if local_port != port {
                continue;
            }

            // Match. SIGKILL the PID. libc::kill returns 0 on success, -1
            // on failure; failures (ESRCH/EPERM) are non-fatal.
            // SAFETY: libc::kill is FFI; passing a valid pid_t and signal
            // number has no memory-safety implications.
            let kill_ret = unsafe { libc::kill(pid, libc::SIGKILL) };
            if kill_ret == 0 {
                log::info!("kill_pid_on_port: SIGKILL pid={} on port={}", pid, port);
                killed_any = true;
            } else {
                let err = std::io::Error::last_os_error();
                log::warn!(
                    "kill_pid_on_port: SIGKILL pid={} on port={} failed: {}",
                    pid,
                    port,
                    err
                );
            }
            // Break out of THIS pid's FD loop — the process is gone.
            break;
        }
    }

    if killed_any {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    Ok(())
}

/// Non-macOS Unix (Linux, BSD): retain the legacy shell-out. App Sandbox
/// doesn't exist on these platforms, so `lsof` works fine. A future Linux
/// build should switch to `/proc/$pid/net/tcp` parsing for the same reason
/// libproc is preferred on macOS (no subprocess fork), but that's a
/// separate change.
#[cfg(all(unix, not(target_os = "macos")))]
async fn kill_pid_on_port_unix(port: u16) -> Result<(), String> {
    use tokio::process::Command;
    let lsof = Command::new("lsof")
        .args(["-i", &format!(":{}", port), "-t"])
        .output()
        .await
        .map_err(|e| format!("lsof spawn failed: {}", e))?;
    let stdout = std::str::from_utf8(&lsof.stdout).unwrap_or("");
    let pids: Vec<&str> = stdout.split_whitespace().collect();
    if pids.is_empty() {
        return Ok(());
    }
    for pid in pids {
        log::info!("kill_pid_on_port: SIGKILL pid={} on port={}", pid, port);
        let _ = Command::new("kill").args(["-9", pid]).status().await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(())
}

#[cfg(windows)]
async fn kill_pid_on_port_windows(port: u16) -> Result<(), String> {
    use tokio::process::Command;
    // netstat -ano outputs lines like:
    //   "  TCP    127.0.0.1:3456    0.0.0.0:0    LISTENING    12345"
    // We grep for ":<port> " (with a trailing space to anchor the port,
    // since netstat right-pads), then pull the last whitespace-delimited
    // token (the PID). Only LISTENING rows count to avoid killing
    // transient TIME_WAIT entries.
    let netstat = Command::new("netstat")
        .args(["-ano"])
        .output()
        .await
        .map_err(|e| format!("netstat spawn failed: {}", e))?;
    let stdout = std::str::from_utf8(&netstat.stdout).unwrap_or("");
    let port_pat = format!(":{} ", port);
    let mut pids = std::collections::HashSet::new();
    for line in stdout.lines() {
        if !line.contains(&port_pat) {
            continue;
        }
        if !line.contains("LISTENING") {
            continue;
        }
        if let Some(pid) = line.split_whitespace().last() {
            pids.insert(pid.to_string());
        }
    }
    if pids.is_empty() {
        return Ok(());
    }
    for pid in pids {
        log::info!(
            "kill_pid_on_port: taskkill /F /PID {} on port={}",
            pid,
            port
        );
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid])
            .status()
            .await;
    }
    tokio::time::sleep(Duration::from_millis(300)).await;
    Ok(())
}

pub async fn discover() -> DiscoveryResult {
    discover_with_retry(true).await
}

/// Inner discovery loop with a retry budget for orphan-sidecar eviction.
///
/// First call is `discover_with_retry(true)`. We only ADOPT an existing server
/// on port 3456 when `should_adopt_external` says so — which in release builds
/// is never (a port-squatter can forge the version string), and in dev only
/// when `CLAUGE_ALLOW_EXTERNAL=1` AND the version matches. Otherwise — whether
/// the occupant is a genuine orphan with a mismatched version OR a
/// version-matching server we still refuse to trust — we kill the PID listening
/// on port 3456 and re-run ourselves with `false`. The second call falls
/// through to `SpawnAt` even if the occupant is still alive (the supervisor's
/// bind will fail and the crash-respawn-backoff handles it). This bounded
/// recursion guarantees termination even if `lsof` is missing.
async fn discover_with_retry(allow_orphan_kill: bool) -> DiscoveryResult {
    let allow_external = std::env::var("CLAUGE_ALLOW_EXTERNAL")
        .map(|v| v == "1")
        .unwrap_or(false);
    if let Some(body) = probe_with_body(3456).await {
        if should_adopt_external(&body, allow_external) {
            return DiscoveryResult::External(3456);
        }
        log::warn!(
            "Not adopting external server on port 3456 (allow_external={}, self={}) — reclaiming the port and spawning our own",
            allow_external,
            env!("CARGO_PKG_VERSION")
        );
        if allow_orphan_kill {
            if let Err(e) = kill_pid_on_port(3456).await {
                log::warn!(
                    "kill_pid_on_port failed: {} — falling through to SpawnAt",
                    e
                );
            }
            return Box::pin(discover_with_retry(false)).await;
        }
        log::warn!(
            "Orphan kill already attempted; falling through to SpawnAt — supervisor backoff will handle"
        );
    }
    DiscoveryResult::SpawnAt(3456)
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

    #[test]
    fn version_matches_self_true_when_version_field_matches_self() {
        let body = format!(
            r#"{{"service":"clauge","version":"{}"}}"#,
            env!("CARGO_PKG_VERSION")
        );
        assert!(version_matches_self(&body));
    }

    #[test]
    fn version_matches_self_false_when_version_mismatch() {
        let body = r#"{"service":"clauge","version":"0.0.0-not-a-real-version"}"#;
        assert!(!version_matches_self(body));
    }

    #[test]
    fn version_matches_self_false_when_missing_field() {
        let body = r#"{"service":"clauge"}"#;
        assert!(!version_matches_self(body));
    }

    #[test]
    fn version_matches_self_false_when_malformed_json() {
        let body = "not json at all";
        assert!(!version_matches_self(body));
    }

    #[tokio::test]
    async fn kill_pid_on_port_succeeds_when_no_pid_listening() {
        // Pick an obscure port that's almost certainly not in use.
        let result = kill_pid_on_port(45679).await;
        assert!(result.is_ok(), "expected Ok, got {:?}", result);
    }

    #[tokio::test]
    async fn probe_with_body_returns_body_for_clauge_response() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/api/health")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"service":"clauge","version":"0.3.0","pid":1}"#)
            .create_async()
            .await;
        let port: u16 = server.url().rsplit(':').next().unwrap().parse().unwrap();
        let body = probe_with_body(port).await;
        assert!(body.is_some(), "expected Some(body), got None");
        assert!(body.unwrap().contains(r#""version":"0.3.0""#));
    }

    #[tokio::test]
    async fn probe_with_body_returns_none_when_no_server() {
        assert!(probe_with_body(45680).await.is_none());
    }

    #[tokio::test]
    async fn probe_with_body_returns_none_for_non_clauge_service() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/api/health")
            .with_status(200)
            .with_body(r#"{"service":"something-else"}"#)
            .create_async()
            .await;
        let port: u16 = server.url().rsplit(':').next().unwrap().parse().unwrap();
        assert!(probe_with_body(port).await.is_none());
    }

    #[test]
    fn should_adopt_external_false_in_release_even_on_version_match() {
        let body = format!(
            r#"{{"service":"clauge","version":"{}"}}"#,
            env!("CARGO_PKG_VERSION")
        );
        assert!(!should_adopt_external(&body, false));
    }

    #[test]
    fn should_adopt_external_true_in_dev_on_version_match() {
        let body = format!(
            r#"{{"service":"clauge","version":"{}"}}"#,
            env!("CARGO_PKG_VERSION")
        );
        assert!(should_adopt_external(&body, true));
    }

    #[test]
    fn should_adopt_external_false_in_dev_on_version_mismatch() {
        let body = r#"{"service":"clauge","version":"0.0.0-nope"}"#;
        assert!(!should_adopt_external(body, true));
    }

    #[tokio::test]
    async fn release_default_does_not_adopt_external_on_version_match() {
        let body = format!(
            r#"{{"service":"clauge","version":"{}"}}"#,
            env!("CARGO_PKG_VERSION")
        );
        // Release default (allow_external = false): a version-matching external
        // server is NOT adopted — we reclaim the port and spawn our own.
        assert!(!should_adopt_external(&body, false));
        assert!(should_adopt_external(&body, true)); // dev escape hatch still adopts
    }
}
