use clauge_lib::connections::{ConnectionState, compose_status};

#[test]
fn test_compose_status_keychain_only() {
    let status = compose_status(
        Some("0.1.8-cli"), // claude code keychain present
        false,             // no claude.ai cookie
        None,              // no extension heartbeat
    );
    assert_eq!(status.claude_code, ConnectionState::Authenticated);
    assert_eq!(status.claude_ai, ConnectionState::NotConnected);
    assert_eq!(status.extension, ConnectionState::NotDetected);
    assert!(status.has_any_plan_data_source());
}

#[test]
fn test_compose_status_all_three() {
    let now = chrono::Utc::now().to_rfc3339();
    let status = compose_status(
        Some("0.1.8-cli"),
        true,
        Some(now),
    );
    assert_eq!(status.claude_code, ConnectionState::Authenticated);
    assert_eq!(status.claude_ai, ConnectionState::SignedIn);
    assert_eq!(status.extension, ConnectionState::Active);
}

#[test]
fn test_compose_status_none() {
    let status = compose_status(None, false, None);
    assert_eq!(status.claude_code, ConnectionState::NotInstalled);
    assert_eq!(status.claude_ai, ConnectionState::NotConnected);
    assert_eq!(status.extension, ConnectionState::NotDetected);
    assert!(!status.has_any_plan_data_source());
}
