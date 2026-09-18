//! Claude Code OAuth credentials reader.
//!
//! Anthropic's Claude Code CLI persists OAuth tokens under the service name
//! "Claude Code-credentials" — on macOS via Keychain Services (this module's
//! historical reason for being called `keychain`), on Windows via a JSON file
//! at `%USERPROFILE%\.claude\.credentials.json`. The blob schema is identical
//! across platforms (verified empirically — see Phase 7 Task A notes at
//! `docs/superpowers/notes/2026-05-15-windows-claude-code-creds.md`).
//!
//! Blob shape (deserialized via `ClaudeCodeCreds`):
//!
//! ```text
//! { "claudeAiOauth": { "accessToken": "...", "refreshToken": "...",
//!                      "expiresAt": <unix-ms>, "scopes": [...],
//!                      "subscriptionType": "...", "rateLimitTier": "..." } }
//! ```
//!
//! macOS DMG: reads via `/usr/bin/security find-generic-password -s
//! "Claude Code-credentials" -w` (see `read_via_security_cli`), never via
//! Keychain Services in-process. Silent on every read — not because of a
//! one-time "Always Allow" grant, but because `/usr/bin/security` IS the
//! keychain item's ACL partition (`apple-tool:`) that Claude Code itself
//! wrote the item under. See AGENTS.md landmine #51. Cached via
//! `keychain_cache.rs` so we only fork `security` once per launch.
//!
//! macOS MAS (v0.9.0+): tries `~/.claude/.credentials.json` first (via the
//! user-granted security-scoped bookmark), falls back to Keychain Services.
//! The Mac CLI is Keychain-only and does NOT write the filesystem mirror,
//! so the filesystem-first attempt almost always falls through to Keychain
//! on Mac MAS. No `keychain-access-groups` entitlement requested; macOS
//! prompts on first read and the user clicks "Always Allow" — but that
//! grant is NOT durable: Claude Code's own token-rotation rewrites of the
//! item reset its ACL partition list, discarding the earlier grant, so the
//! prompt can recur later in the app's lifetime. See AGENTS.md landmine #51.
//!
//! Windows: file-backed; no prompt, no cache strictly required, but
//! `keychain_cache.rs` still reduces filesystem reads on rapid polling.
//!
//! Linux: not supported (returns `UnsupportedPlatform`).

use serde::Deserialize;

/// The Keychain Services service name Claude Code CLI writes its OAuth blob to.
/// Stable across Claude Code versions (verified 2026-05-14).
pub const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

/// Wrapper for the actual Claude Code keychain blob. The blob has a
/// `claudeAiOauth` top-level key (camelCase) plus an unrelated `mcpOAuth`
/// section we ignore. Empirically verified 2026-05-14 against a live
/// `Claude Code-credentials` entry.
#[derive(Deserialize, Clone)]
pub struct ClaudeCodeCreds {
    #[serde(rename = "claudeAiOauth")]
    pub claude_ai_oauth: ClaudeAiOauth,
}

/// The actual OAuth credentials Anthropic's CLI persists.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeAiOauth {
    /// Bearer token for api.anthropic.com OAuth endpoints. Long-lived but
    /// not infinite; check `expires_at` against now() to gauge freshness.
    pub access_token: String,
    /// Used to refresh `access_token` when it expires. May be absent for
    /// session-only auths.
    pub refresh_token: Option<String>,
    /// Unix epoch in MILLISECONDS when `access_token` becomes invalid.
    /// (NOT seconds, NOT ISO 8601 — confirmed empirically.)
    pub expires_at: Option<i64>,
    /// OAuth scopes granted to Claude Code; informational.
    pub scopes: Option<Vec<String>>,
    /// Anthropic subscription tier — e.g. "max", "pro", "free".
    pub subscription_type: Option<String>,
    /// Rate-limit bucket Anthropic assigns — e.g. "default_claude_max_20x".
    pub rate_limit_tier: Option<String>,
}

impl std::fmt::Debug for ClaudeCodeCreds {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeCodeCreds")
            .field("claude_ai_oauth", &self.claude_ai_oauth)
            .finish()
    }
}

impl std::fmt::Debug for ClaudeAiOauth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeAiOauth")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes)
            .field("subscription_type", &self.subscription_type)
            .field("rate_limit_tier", &self.rate_limit_tier)
            .finish()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error("Claude Code keychain entry not found (user may not have run `claude /login`)")]
    NotFound,
    #[error("keychain access denied (user clicked Deny on the prompt)")]
    AccessDenied,
    #[error("failed to parse keychain blob as JSON: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("security-framework error (OSStatus {code}): {message}")]
    Framework { code: i32, message: String },
    #[error("filesystem error reading credentials: {0}")]
    Io(#[from] std::io::Error),
    #[error("not supported on this platform")]
    UnsupportedPlatform,
    /// DMG-flavor CLI path (`read_via_security_cli`) only: an unrecognized
    /// `/usr/bin/security` exit code, a signal kill (`code: -1`), or a
    /// failure to even spawn the process (`code: -1`, `message` wraps the
    /// `io::Error`). Not cfg-gated — same precedent as `UnsupportedPlatform`,
    /// which is never constructed on macOS either: a variant that's only
    /// ever built on one platform doesn't need a `#[cfg]` to stay truthful,
    /// it just needs to never be *displayed* as something it isn't (see the
    /// `Framework`/`Io` mismatch this variant replaces on the CLI path).
    #[error("/usr/bin/security failed (exit status {code}): {message}")]
    SecurityCli { code: i32, message: String },
}

/// Map a raw macOS Security framework OSStatus to a structured KeychainError.
/// Known codes:
/// - errSecItemNotFound (-25300) → NotFound
/// - errSecUserCanceled (-128)   → AccessDenied
/// - errSecAuthFailed (-25293)   → AccessDenied (user denied or auth flow failed)
///
/// Anything else falls through to Framework { code, message }.
///
/// Gated on `any(feature = "mas", test)`, not just `feature = "mas"`: this
/// is production code only under the MAS flavor, but its 4 unit tests below
/// must still run under `cargo test`'s default features, since CI never
/// builds `--features mas`. Gating it on `feature = "mas"` alone silently
/// dropped those 4 tests from every CI gate — see AGENTS.md landmine #51.
#[cfg(all(target_os = "macos", any(feature = "mas", test)))]
fn map_osstatus_to_error(code: i32, msg: &str) -> KeychainError {
    match code {
        -25300 => KeychainError::NotFound,
        -128 | -25293 => KeychainError::AccessDenied,
        _ => KeychainError::Framework {
            code,
            message: msg.to_string(),
        },
    }
}

/// MAS-flavor Mac: read Claude Code OAuth credentials directly from
/// Keychain Services in-process (service name "Claude Code-credentials"),
/// via the `security-framework` crate. The App Sandbox cannot fork
/// `/usr/bin/security` (the DMG flavor's `read_via_security_cli` path), so
/// this in-process reader is the only option under MAS.
///
/// This reader presents this app's own code-signing identity as the
/// Keychain client, which does NOT match the item's ACL partition list
/// (`apple-tool:` — the identity Claude Code itself reads/writes the item
/// under). macOS therefore prompts on read, and "Always Allow" does NOT
/// silence it permanently: Claude Code rewrites the item (rotating the
/// OAuth token) on its own cadence, and each rewrite resets the ACL
/// partition list, discarding the earlier grant. So this MAS path may
/// prompt repeatedly over the app's lifetime, unlike the DMG flavor. See
/// AGENTS.md landmine #51 for the underlying evidence. No
/// `keychain-access-groups` entitlement requested; the runtime prompt IS
/// the user opt-in.
#[cfg(all(target_os = "macos", feature = "mas"))]
fn read_from_keychain_services() -> Result<ClaudeCodeCreds, KeychainError> {
    use security_framework::item::{ItemClass, ItemSearchOptions, Limit, SearchResult};

    // Claude Code CLI writes its OAuth entry with account = <macOS short username>
    // (e.g. "adnanrashid"). We don't want to hardcode the account, so we search by
    // service only and take the first match. This mirrors the behavior of:
    //   security find-generic-password -s "Claude Code-credentials" -w
    let search = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(KEYCHAIN_SERVICE)
        .load_data(true)
        .limit(Limit::Max(1))
        .search();

    let results = match search {
        Ok(r) => r,
        Err(e) => {
            // security-framework 2.x exposes the raw OSStatus via Error::code().
            // Use that instead of fragile substring matching on the formatted message.
            let code = e.code();
            return Err(map_osstatus_to_error(code, &e.to_string()));
        }
    };

    // No matches → NotFound (search returned empty Ok).
    let first = results.into_iter().next().ok_or(KeychainError::NotFound)?;

    // Extract the password bytes. With load_data(true), expect SearchResult::Data.
    let blob: Vec<u8> = match first {
        SearchResult::Data(bytes) => bytes,
        other => {
            // Not an OSStatus error — this is an internal invariant violation
            // (we asked for Data via load_data(true) but got something else).
            // Use code=0 (errSecSuccess) as a sentinel since there's no real status.
            return Err(KeychainError::Framework {
                code: 0,
                message: format!(
                    "unexpected SearchResult variant (expected Data): {:?}",
                    other
                ),
            });
        }
    };

    let creds = parse_creds_blob(&blob)?;
    Ok(creds)
}

/// Parses a raw credentials blob (from the keychain CLI's stdout, the
/// in-process Keychain Services reader, or a filesystem `.credentials.json`)
/// into `ClaudeCodeCreds`, WITHOUT letting a parse failure leak any part of
/// the blob's VALUES into the returned error.
///
/// `serde_json`'s own "invalid type" / "missing field" errors embed the
/// offending VALUE verbatim (e.g. `invalid type: string "<token>", expected
/// struct ClaudeAiOauth`) — if the blob is malformed in a way that still
/// puts a real token string where a struct/number was expected, the raw
/// `serde_json::Error` would carry that token straight into
/// `KeychainError::Parse`, and from there into `log::warn!` calls and the
/// IPC error string sent to the webview. This helper keeps only the parse
/// error's CATEGORY and byte position (line/column) — enough to debug a
/// shape mismatch from a bug report, never enough to leak a secret.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn parse_creds_blob(blob: &[u8]) -> Result<ClaudeCodeCreds, KeychainError> {
    serde_json::from_slice(blob).map_err(|e: serde_json::Error| {
        KeychainError::Parse(<serde_json::Error as serde::de::Error>::custom(format!(
            "{:?} error at line {} column {}",
            e.classify(),
            e.line(),
            e.column()
        )))
    })
}

/// Absolute path to the `security` CLI — never a PATH lookup, never a shell.
#[cfg(all(target_os = "macos", not(feature = "mas")))]
const SECURITY_CLI_PATH: &str = "/usr/bin/security";

/// Pure: maps a completed `/usr/bin/security find-generic-password -s
/// "Claude Code-credentials" -w` invocation's exit code + stdout/stderr to a
/// `ClaudeCodeCreds` or a structured `KeychainError`. `security`'s exit code
/// is the LOW BYTE of the underlying OSStatus (see AGENTS.md landmine #51):
/// - `Some(0)`          — success; stdout is the JSON blob (a trailing
///   newline is fine).
/// - `Some(44)`         — errSecItemNotFound (-25300) → NotFound.
/// - `Some(51)`         — errSecAuthFailed (-25293) → AccessDenied.
/// - `Some(128)`        — errSecUserCanceled (-128) → AccessDenied.
/// - anything else, including `None` (killed by signal, reported as
///   `code: -1`) → `SecurityCli`, using only the first line of stderr,
///   trimmed and capped at 200 chars.
///
/// stdout (which may hold the secret) is only ever handed to
/// `parse_creds_blob` (the `Some(0)` branch), which discards the parsed
/// VALUES and keeps only the JSON error's category + line/column on
/// failure. So stdout's contents are NEVER placed into any error, log, or
/// Debug output — only stderr's first line is. That is safe because `-w`
/// writes the secret to STDOUT only; `-g` is the flag that prints
/// `password: "..."` to STDERR, which is why this code never passes `-g`
/// (the wiring-guard test enforces it). The first-line cap is
/// belt-and-braces.
#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn parse_security_cli_output(
    exit_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<ClaudeCodeCreds, KeychainError> {
    const MAX_MESSAGE_LEN: usize = 200;

    match exit_code {
        Some(0) => parse_creds_blob(stdout),
        Some(44) => Err(KeychainError::NotFound),
        Some(51) | Some(128) => Err(KeychainError::AccessDenied),
        other => {
            let message = String::from_utf8_lossy(stderr)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(MAX_MESSAGE_LEN)
                .collect();
            Err(KeychainError::SecurityCli {
                code: other.unwrap_or(-1),
                message,
            })
        }
    }
}

/// DMG-flavor Mac: read Claude Code OAuth credentials by forking
/// `/usr/bin/security find-generic-password -s "Claude Code-credentials"
/// -w` — never via Keychain Services in-process. See AGENTS.md landmine
/// #51: Claude Code itself reads/writes the item through the `security`
/// CLI, so shelling out to the same tool IS the item's `apple-tool:` ACL
/// partition and reads silently, with no fallback to the in-process reader
/// (a silent fallback would resurrect the prompt this fix removes).
#[cfg(all(target_os = "macos", not(feature = "mas")))]
fn read_via_security_cli() -> Result<ClaudeCodeCreds, KeychainError> {
    use std::process::{Command, Stdio};

    // A failure to even spawn `/usr/bin/security` (missing binary, sandbox
    // denial, resource exhaustion, ...) is neither a `security-framework`
    // error (that's the MAS in-process reader's path, never this one) nor
    // a "filesystem error reading credentials" (`Io`) — it's a failure to
    // run the CLI at all. `SecurityCli` says that truthfully.
    let output = Command::new(SECURITY_CLI_PATH)
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| KeychainError::SecurityCli {
            code: -1,
            message: format!("could not run /usr/bin/security: {}", e),
        })?;

    parse_security_cli_output(output.status.code(), &output.stdout, &output.stderr)
}

/// DMG-flavor entry point. See `read_via_security_cli` above for the
/// AGENTS.md landmine #51 rationale — this is the sole credential source
/// for the DMG flavor, with no fallback to Keychain Services in-process.
#[cfg(all(target_os = "macos", not(feature = "mas")))]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    read_via_security_cli()
}

/// MAS-flavor Mac: try `~/.claude/.credentials.json` first via the
/// user-granted security-scoped bookmark, then fall back to Keychain Services.
///
/// Why the fallback (amended 2026-05-17 after Task 12 smoke):
/// macOS Claude Code CLI does NOT write a filesystem `.credentials.json` —
/// it stores credentials exclusively in Keychain Services
/// (`Claude Code-credentials` service). The filesystem mirror is a Windows-port
/// artifact (`%USERPROFILE%\.claude\.credentials.json`). So for the typical
/// Mac user, the filesystem path doesn't exist and we MUST fall back to
/// Keychain. The Keychain read triggers a macOS user prompt on access;
/// unlike the DMG flavor's `/usr/bin/security` path, "Always Allow" here
/// does NOT silence subsequent reads permanently — Claude Code's own
/// token-rotation rewrites reset the item's ACL partition list, so this
/// in-process reader (`read_from_keychain_services`) may prompt again
/// later. See AGENTS.md landmine #51. **No `keychain-access-groups`
/// entitlement requested** — the runtime prompt IS the user opt-in. Apple
/// Review surface stays clean.
///
/// Zero-arg signature (Option B from v0.9.0 spec § Credential reading):
/// preserves the `keychain_cache::ReaderFn` zero-arg closure type intact —
/// no cache rewrite, no `&AppHandle` plumbing, no test-injection churn.
#[cfg(all(target_os = "macos", feature = "mas"))]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    // 1) Try the filesystem first (covers the rare user who has
    //    .credentials.json — e.g., from a manual `security` export, or a
    //    future Mac CLI version that writes the file).
    if let Some(claude_dir) = crate::security_scoped_bookmark::MAS_CLAUDE_DIR.get() {
        let path = claude_dir.join(".credentials.json");
        if path.exists() {
            return read_from_path_unix(&path);
        }
    }
    // 2) Fall back to Keychain Services (in-process, via
    //    read_from_keychain_services). The typical Mac MAS path. May
    //    prompt more than once over the app's lifetime — Claude Code's own
    //    token rewrites reset the item's ACL partition, which "Always
    //    Allow" doesn't survive. See AGENTS.md landmine #51.
    read_from_keychain_services()
}

/// Internal: read + parse credentials file at a given Unix path. Mirrors
/// the Windows `read_from_path` helper. Factored so future MAS-Mac unit
/// tests can exercise the parse/error logic with a temp file without
/// touching the global `MAS_CLAUDE_DIR` OnceLock.
#[cfg(all(target_os = "macos", feature = "mas"))]
fn read_from_path_unix(path: &std::path::Path) -> Result<ClaudeCodeCreds, KeychainError> {
    let blob = std::fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => KeychainError::NotFound,
        std::io::ErrorKind::PermissionDenied => KeychainError::AccessDenied,
        _ => KeychainError::Io(e),
    })?;
    let creds = parse_creds_blob(&blob)?;
    Ok(creds)
}

/// Windows: read Claude Code OAuth credentials from the per-user JSON file
/// at %USERPROFILE%\.claude\.credentials.json. The CLI persists the same blob
/// format Mac stores in Keychain Services (verified by Phase 7 Task A:
/// docs/superpowers/notes/2026-05-15-windows-claude-code-creds.md).
///
/// Note: the filename has a leading dot (`.credentials.json`, not
/// `credentials.json`) — Unix-style hidden-file convention that Claude Code
/// uses across platforms.
#[cfg(target_os = "windows")]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    let userprofile = std::env::var("USERPROFILE").map_err(|e| KeychainError::Framework {
        code: 0,
        message: format!("USERPROFILE env var not set: {}", e),
    })?;
    let path = std::path::PathBuf::from(userprofile)
        .join(".claude")
        .join(".credentials.json");
    read_from_path(&path)
}

/// Internal: read + parse the credentials file at a given path. Factored out
/// so tests can exercise the parse/error logic with a temp file.
#[cfg(target_os = "windows")]
fn read_from_path(path: &std::path::Path) -> Result<ClaudeCodeCreds, KeychainError> {
    let blob = std::fs::read(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => KeychainError::NotFound,
        std::io::ErrorKind::PermissionDenied => KeychainError::AccessDenied,
        _ => KeychainError::Io(e),
    })?;
    let creds = parse_creds_blob(&blob)?;
    Ok(creds)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub fn read_claude_code_credentials() -> Result<ClaudeCodeCreds, KeychainError> {
    Err(KeychainError::UnsupportedPlatform)
}

/// Returns true if `expires_at` is in the past. Absent expiry returns false
/// (assume valid until a 401 disproves us).
pub fn is_expired(creds: &ClaudeCodeCreds) -> bool {
    let Some(expires_at_ms) = creds.claude_ai_oauth.expires_at else {
        return false;
    };
    let now_ms = chrono::Utc::now().timestamp_millis();
    expires_at_ms < now_ms
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;

    // -- map_osstatus_to_error (AGENTS.md landmine #51 F3) --
    // No `#[cfg(feature = "mas")]` here: the function itself is gated
    // `any(feature = "mas", test)` so these 4 tests compile and run under
    // `cargo test`'s default features, same as every other test in this
    // module. Gating the tests on `feature = "mas"` silently dropped them
    // from every CI gate (CI never builds `--features mas`).

    #[test]
    fn errno_minus_25300_maps_to_not_found() {
        // errSecItemNotFound = -25300
        let err = map_osstatus_to_error(-25300, "test");
        assert!(matches!(err, KeychainError::NotFound), "got {:?}", err);
    }

    #[test]
    fn errno_minus_128_maps_to_access_denied() {
        // errSecUserCanceled = -128
        let err = map_osstatus_to_error(-128, "test");
        assert!(matches!(err, KeychainError::AccessDenied), "got {:?}", err);
    }

    #[test]
    fn errno_unknown_maps_to_framework() {
        let err = map_osstatus_to_error(-99999, "boom");
        match err {
            KeychainError::Framework { code, message } => {
                assert_eq!(code, -99999);
                assert_eq!(message, "boom");
            }
            other => panic!("expected Framework variant, got {:?}", other),
        }
    }

    #[test]
    fn errno_minus_25293_maps_to_access_denied() {
        // errSecAuthFailed = -25293
        let err = map_osstatus_to_error(-25293, "test");
        assert!(matches!(err, KeychainError::AccessDenied), "got {:?}", err);
    }

    // -- DMG-flavor `/usr/bin/security` CLI reader (AGENTS.md landmine #51) --
    // Gated the same as the production code under test: macOS (from the
    // enclosing `mod tests`) + `not(feature = "mas")`.

    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_parses_valid_blob_with_trailing_newline() {
        let stdout = b"{\"claudeAiOauth\":{\"accessToken\":\"FAKE-ACCESS-TOKEN-FOR-TEST\",\"refreshToken\":\"FAKE-REFRESH-TOKEN-FOR-TEST\",\"expiresAt\":1900000000000,\"scopes\":[\"user:inference\"],\"subscriptionType\":\"max\",\"rateLimitTier\":\"default_claude_max_20x\"}}\n";
        let creds = parse_security_cli_output(Some(0), stdout, b"").expect("expected Ok");
        assert_eq!(
            creds.claude_ai_oauth.access_token,
            "FAKE-ACCESS-TOKEN-FOR-TEST"
        );
    }

    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_tolerates_unknown_fields() {
        // refreshTokenExpiresAt is not a field on ClaudeAiOauth; mcpOAuth is
        // an unrelated sibling object the real blob carries. Both must be
        // ignored, not rejected.
        let stdout = br#"{"claudeAiOauth":{"accessToken":"FAKE-ACCESS-TOKEN-FOR-TEST","refreshTokenExpiresAt":1234567890},"mcpOAuth":{"foo":"bar"}}"#;
        let creds = parse_security_cli_output(Some(0), stdout, b"")
            .expect("expected Ok despite unknown fields");
        assert_eq!(
            creds.claude_ai_oauth.access_token,
            "FAKE-ACCESS-TOKEN-FOR-TEST"
        );
    }

    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_exit_44_is_not_found() {
        let err = parse_security_cli_output(Some(44), b"", b"").unwrap_err();
        assert!(matches!(err, KeychainError::NotFound), "got {:?}", err);
    }

    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_exit_51_and_128_are_access_denied() {
        let err_51 = parse_security_cli_output(Some(51), b"", b"").unwrap_err();
        assert!(
            matches!(err_51, KeychainError::AccessDenied),
            "got {:?}",
            err_51
        );
        let err_128 = parse_security_cli_output(Some(128), b"", b"").unwrap_err();
        assert!(
            matches!(err_128, KeychainError::AccessDenied),
            "got {:?}",
            err_128
        );
    }

    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_unknown_exit_code_is_security_cli_and_never_leaks_stdout() {
        let stdout = b"FAKE-SECRET-TOKEN-LEAK-CHECK";
        let stderr = b"security: SecKeychainSearchCopyNext: some weird error\nsecond line ignored";
        let err = parse_security_cli_output(Some(7), stdout, stderr).unwrap_err();
        match &err {
            KeychainError::SecurityCli { code, message } => {
                assert_eq!(*code, 7);
                assert_eq!(
                    message,
                    "security: SecKeychainSearchCopyNext: some weird error"
                );
            }
            other => panic!("expected SecurityCli, got {:?}", other),
        }
        let display = format!("{}", err);
        let debug = format!("{:?}", err);
        assert!(
            !display.contains("FAKE-SECRET-TOKEN-LEAK-CHECK"),
            "Display leaked stdout: {}",
            display
        );
        assert!(
            !debug.contains("FAKE-SECRET-TOKEN-LEAK-CHECK"),
            "Debug leaked stdout: {}",
            debug
        );
    }

    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_signal_kill_is_security_cli_code_negative_one() {
        let err = parse_security_cli_output(None, b"", b"killed by signal").unwrap_err();
        match err {
            KeychainError::SecurityCli { code, .. } => assert_eq!(code, -1),
            other => panic!("expected SecurityCli, got {:?}", other),
        }
    }

    /// F5 — the 200-char cap and whitespace trim were implemented but
    /// never independently tested. stderr's first line has leading AND
    /// trailing whitespace around 300 'a's, so both the trim and the cap
    /// have to fire for this to pass; a second stderr line ("second line")
    /// must never appear (only the first line is used at all).
    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_message_is_trimmed_then_capped_at_200_chars() {
        let first_line = format!("   {}   ", "a".repeat(300));
        let stderr = format!("{}\nsecond line", first_line);
        let err = parse_security_cli_output(Some(7), b"", stderr.as_bytes()).unwrap_err();
        match err {
            KeychainError::SecurityCli { message, .. } => {
                assert_eq!(message.chars().count(), 200, "got: {:?}", message);
                assert_eq!(
                    message.trim(),
                    message,
                    "message must have no leading/trailing whitespace: {:?}",
                    message
                );
                assert!(
                    !message.contains("second line"),
                    "message must not contain stderr's second line: {:?}",
                    message
                );
            }
            other => panic!("expected SecurityCli, got {:?}", other),
        }
    }

    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_exit_0_garbage_stdout_is_parse_error() {
        let stdout = b"FAKE-GARBAGE-NOT-JSON-TOKEN";
        let err = parse_security_cli_output(Some(0), stdout, b"").unwrap_err();
        assert!(matches!(err, KeychainError::Parse(_)), "got {:?}", err);
        let display = format!("{}", err);
        assert!(
            !display.contains("FAKE-GARBAGE-NOT-JSON-TOKEN"),
            "Parse error text leaked garbage stdout: {}",
            display
        );
    }

    /// F1 (security, 2 Opus reviewers): serde_json embeds the offending
    /// VALUE in invalid-type errors. A wrong-shape blob (the OAuth object
    /// replaced with a bare string) reproduces the exact shape a rotated/
    /// corrupted keychain entry could hand us. Neither Display nor Debug of
    /// the resulting KeychainError may contain the secret; Display must
    /// still carry enough position info ("line") to debug the parse
    /// failure from a bug report.
    #[test]
    #[cfg(not(feature = "mas"))]
    fn parse_security_cli_output_exit_0_wrong_shape_does_not_leak_secret_in_error() {
        let stdout = br#"{"claudeAiOauth":"FAKE-SECRET-TOKEN-IN-WRONG-SHAPE"}"#;
        let err = parse_security_cli_output(Some(0), stdout, b"").unwrap_err();
        assert!(matches!(err, KeychainError::Parse(_)), "got {:?}", err);
        let display = format!("{}", err);
        let debug = format!("{:?}", err);
        assert!(
            !display.contains("FAKE-SECRET-TOKEN-IN-WRONG-SHAPE"),
            "Display leaked the secret: {}",
            display
        );
        assert!(
            !debug.contains("FAKE-SECRET-TOKEN-IN-WRONG-SHAPE"),
            "Debug leaked the secret: {}",
            debug
        );
        assert!(
            display.contains("line"),
            "Display should still carry position info: {}",
            display
        );
    }

    /// WIRING GUARD (AGENTS.md landmine #51): scans this file's own source
    /// (via `include_str!`) to assert the DMG-flavor
    /// `read_claude_code_credentials` calls `read_via_security_cli` and NOT
    /// the in-process `read_from_keychain_services`, and that
    /// `read_from_keychain_services` itself is gated on `feature = "mas"`.
    /// The DMG-flavor function's cfg+signature line sits ABOVE this `tests`
    /// module in the file, so `.find()` (which returns the FIRST match)
    /// locks onto the production definition — this test's own string
    /// literals (below, later in the file) cannot produce a false pass.
    #[test]
    #[cfg(not(feature = "mas"))]
    fn dmg_reader_uses_security_cli_not_in_process_keychain() {
        let source = include_str!("keychain.rs");

        let dmg_cfg_and_sig = "#[cfg(all(target_os = \"macos\", not(feature = \"mas\")))]\npub fn read_claude_code_credentials";
        let start = source
            .find(dmg_cfg_and_sig)
            .expect("DMG-flavor read_claude_code_credentials cfg+signature not found");
        let body_end = source[start..]
            .find("\n}\n")
            .map(|rel| start + rel + "\n}\n".len())
            .expect("could not find end of DMG-flavor read_claude_code_credentials body");
        let body = &source[start..body_end];

        assert!(
            body.contains("read_via_security_cli("),
            "DMG-flavor read_claude_code_credentials must call read_via_security_cli(); body was:\n{}",
            body
        );
        assert!(
            !body.contains("read_from_keychain_services"),
            "DMG-flavor read_claude_code_credentials must NOT call the in-process keychain reader; body was:\n{}",
            body
        );

        let mas_fn_sig = "fn read_from_keychain_services";
        let mas_fn_idx = source
            .find(mas_fn_sig)
            .expect("read_from_keychain_services definition not found");
        let preceding = &source[..mas_fn_idx];
        let attr_start = preceding
            .rfind("#[cfg(")
            .expect("no cfg attribute found above read_from_keychain_services");
        let attr_line = &preceding[attr_start..];
        // Exact-equality, not `.contains("feature = \"mas\"")` — that
        // substring also matches `not(feature = "mas")`, so it would pass
        // even if this function were accidentally re-gated to the DMG
        // flavor (3 Opus reviewers flagged this as non-discriminating).
        let expected_mas_cfg = "#[cfg(all(target_os = \"macos\", feature = \"mas\"))]";
        assert_eq!(
            attr_line.trim(),
            expected_mas_cfg,
            "read_from_keychain_services must be gated exactly on {}; found: {}",
            expected_mas_cfg,
            attr_line.trim()
        );

        // read_via_security_cli must use `-w` (print password to stdout
        // only) and never `-g` (which additionally echoes the password to
        // STDERR — and parse_security_cli_output's SecurityCli branch copies
        // stderr's first line into error messages, so `-g` would leak the
        // secret through that path).
        let cli_fn_sig = "fn read_via_security_cli";
        let cli_fn_idx = source
            .find(cli_fn_sig)
            .expect("read_via_security_cli definition not found");
        let cli_body_end = source[cli_fn_idx..]
            .find("\n}\n")
            .map(|rel| cli_fn_idx + rel + "\n}\n".len())
            .expect("could not find end of read_via_security_cli body");
        let cli_body = &source[cli_fn_idx..cli_body_end];
        assert!(
            cli_body.contains("\"-w\""),
            "read_via_security_cli must pass the -w flag; body was:\n{}",
            cli_body
        );
        assert!(
            !cli_body.contains("\"-g\""),
            "read_via_security_cli must NOT pass the -g flag (leaks the password to stderr); body was:\n{}",
            cli_body
        );
    }

    /// Live smoke test — requires a real "Claude Code-credentials" keychain
    /// item on this Mac (CI has none, hence #[ignore]). Run explicitly:
    /// `cargo test --manifest-path src-tauri/Cargo.toml live_security_cli_read_is_ok -- --ignored`
    /// Asserts Ok + a non-empty token WITHOUT ever printing the token itself.
    #[test]
    #[ignore]
    #[cfg(not(feature = "mas"))]
    fn live_security_cli_read_is_ok() {
        let creds =
            read_via_security_cli().expect("expected Ok reading the live macOS keychain item");
        assert!(
            !creds.claude_ai_oauth.access_token.is_empty(),
            "expected non-empty access token"
        );
    }
}

#[cfg(test)]
#[cfg(target_os = "windows")]
mod windows_tests {
    use super::*;
    use std::io::Write;

    fn sample_creds_json() -> &'static str {
        r#"{"claudeAiOauth":{"accessToken":"a-token","refreshToken":"r-token","expiresAt":1900000000000,"scopes":["user:inference"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}"#
    }

    #[test]
    fn read_from_path_returns_not_found_for_missing_file() {
        let path =
            std::env::temp_dir().join(format!("clauge-test-missing-{}.json", std::process::id()));
        // Ensure it doesn't exist
        let _ = std::fs::remove_file(&path);
        let err = read_from_path(&path).expect_err("expected NotFound");
        assert!(matches!(err, KeychainError::NotFound), "got {:?}", err);
    }

    #[test]
    fn read_from_path_parses_valid_json() {
        let path =
            std::env::temp_dir().join(format!("clauge-test-valid-{}.json", std::process::id()));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(sample_creds_json().as_bytes()).unwrap();
        drop(f);

        let creds = read_from_path(&path).expect("read should succeed");
        assert_eq!(creds.claude_ai_oauth.access_token, "a-token");
        assert_eq!(
            creds.claude_ai_oauth.refresh_token.as_deref(),
            Some("r-token")
        );
        assert_eq!(creds.claude_ai_oauth.expires_at, Some(1_900_000_000_000));
        assert_eq!(
            creds.claude_ai_oauth.subscription_type.as_deref(),
            Some("max")
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_from_path_returns_parse_error_for_garbage() {
        let path =
            std::env::temp_dir().join(format!("clauge-test-garbage-{}.json", std::process::id()));
        std::fs::write(&path, b"not valid json at all").unwrap();

        let err = read_from_path(&path).expect_err("expected Parse error");
        assert!(matches!(err, KeychainError::Parse(_)), "got {:?}", err);

        let _ = std::fs::remove_file(&path);
    }
}
