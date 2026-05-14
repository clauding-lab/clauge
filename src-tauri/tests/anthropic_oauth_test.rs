use clauge_lib::anthropic_oauth::fetch_oauth_usage;
use serial_test::serial;

#[tokio::test]
#[serial]
async fn test_fetch_oauth_usage_returns_parsed_response() {
    let mut server = mockito::Server::new_async().await;
    let mock = server.mock("GET", "/api/oauth/usage")
        .match_header("authorization", "Bearer test-token-123")
        .match_header("anthropic-version", "2023-06-01")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{
            "five_hour_limit_pct": 0.42,
            "weekly_limit_pct": 0.18,
            "models": {
                "sonnet": { "weekly_pct": 0.12 },
                "opus": { "weekly_pct": 0.05 }
            }
        }"#)
        .create_async().await;

    // Override the base URL via an env var the impl reads (see Task 5 Step 4).
    std::env::set_var("CLAUGE_ANTHROPIC_BASE_URL", server.url());

    let result = fetch_oauth_usage("test-token-123").await;
    assert!(result.is_ok(), "fetch failed: {:?}", result.err());

    let usage = result.unwrap();
    assert_eq!(usage.five_hour_limit_pct, Some(0.42));
    assert_eq!(usage.weekly_limit_pct, Some(0.18));

    mock.assert_async().await;
    std::env::remove_var("CLAUGE_ANTHROPIC_BASE_URL");
}

#[tokio::test]
#[serial]
async fn test_fetch_oauth_usage_returns_token_expired_on_401() {
    let mut server = mockito::Server::new_async().await;
    let mock = server.mock("GET", "/api/oauth/usage")
        .with_status(401)
        .with_body(r#"{"error":"invalid_token"}"#)
        .create_async().await;

    std::env::set_var("CLAUGE_ANTHROPIC_BASE_URL", server.url());

    let result = fetch_oauth_usage("expired-token").await;
    assert!(matches!(result, Err(clauge_lib::anthropic_oauth::OAuthError::TokenExpired)));

    mock.assert_async().await;
    std::env::remove_var("CLAUGE_ANTHROPIC_BASE_URL");
}
