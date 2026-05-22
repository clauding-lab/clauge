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
            "five_hour": {"utilization": 13.0, "resets_at": "2026-05-14T10:30:00.872898+00:00"},
            "seven_day": {"utilization": 4.0, "resets_at": "2026-05-20T22:59:59.872917+00:00"},
            "seven_day_oauth_apps": null,
            "seven_day_opus": null,
            "seven_day_sonnet": {"utilization": 0.0, "resets_at": "2026-05-20T22:59:59.872928+00:00"},
            "seven_day_cowork": null,
            "seven_day_omelette": {"utilization": 0.0, "resets_at": null},
            "tangelo": null,
            "iguana_necktie": null,
            "omelette_promotional": null,
            "extra_usage": {
                "is_enabled": true,
                "monthly_limit": 1000,
                "used_credits": 0.0,
                "utilization": null,
                "currency": "USD",
                "disabled_reason": null
            }
        }"#)
        .create_async().await;

    std::env::set_var("CLAUGE_ANTHROPIC_BASE_URL", server.url());

    let result = fetch_oauth_usage("test-token-123").await;
    assert!(result.is_ok(), "fetch failed: {:?}", result.err());

    let usage = result.unwrap();

    // 5-hour window
    let five_hour = usage.five_hour.expect("five_hour should be present");
    assert_eq!(five_hour.utilization, 13.0);
    assert_eq!(
        five_hour.resets_at.as_deref(),
        Some("2026-05-14T10:30:00.872898+00:00")
    );

    // 7-day window
    let seven_day = usage.seven_day.expect("seven_day should be present");
    assert_eq!(seven_day.utilization, 4.0);

    // 7-day Sonnet model breakdown
    let sonnet = usage
        .seven_day_sonnet
        .expect("seven_day_sonnet should be present");
    assert_eq!(sonnet.utilization, 0.0);

    // Null fields parse cleanly to None
    assert!(usage.seven_day_opus.is_none());
    assert!(usage.tangelo.is_none());

    // Field with null resets_at (omelette)
    let omelette = usage
        .seven_day_omelette
        .expect("seven_day_omelette should be present");
    assert_eq!(omelette.utilization, 0.0);
    assert!(omelette.resets_at.is_none());

    // extra_usage block
    let extra = usage.extra_usage.expect("extra_usage should be present");
    assert!(extra.is_enabled);
    assert_eq!(extra.monthly_limit, 1000);
    assert_eq!(extra.used_credits, 0.0);
    assert!(extra.utilization.is_none());
    assert_eq!(extra.currency, "USD");
    assert!(extra.disabled_reason.is_none());

    mock.assert_async().await;
    std::env::remove_var("CLAUGE_ANTHROPIC_BASE_URL");
}

#[tokio::test]
#[serial]
async fn test_fetch_oauth_usage_returns_token_expired_on_401() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
        .mock("GET", "/api/oauth/usage")
        .with_status(401)
        .with_body(r#"{"error":"invalid_token"}"#)
        .create_async()
        .await;

    std::env::set_var("CLAUGE_ANTHROPIC_BASE_URL", server.url());

    let result = fetch_oauth_usage("expired-token").await;
    assert!(matches!(
        result,
        Err(clauge_lib::anthropic_oauth::OAuthError::TokenExpired)
    ));

    mock.assert_async().await;
    std::env::remove_var("CLAUGE_ANTHROPIC_BASE_URL");
}
