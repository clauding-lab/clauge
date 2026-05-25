# Security Policy

Thanks for taking the time to review Clauge's security surface. This document tells you how to report a vulnerability and what falls inside vs. outside our scope.

## Reporting a vulnerability

**Do not file a public GitHub issue** for anything that looks like a security problem. Use one of:

1. **GitHub private vulnerability advisory** *(preferred)* — open one at
   <https://github.com/clauding-lab/clauge/security/advisories/new>.
   GitHub keeps the report private until we publish a fix.
2. **Email** — `adnan.rshd@gmail.com` with `[Clauge Security]` in the subject.
   PGP key not currently published; if you need an encrypted channel, ask in the
   first email and we'll set one up.

Please include:

- Clauge version (`clauge --version` or About panel).
- Operating system + version.
- Reproduction steps. A minimal proof-of-concept is ideal but not required.
- Impact assessment from your point of view.

We aim to acknowledge receipt within 48 hours and post a fix or mitigation
within 14 days for high-severity issues. Lower-severity issues may take longer
depending on release cadence; we'll keep you in the loop.

## Scope

In scope:

- **Keychain interactions.** Clauge reads `Claude Code-credentials` and writes
  `com.clauding.clauge.claude-ai-session` /
  `com.clauding.clauge.trial-counter` /
  `com.clauding.clauge.anthropic-admin-key` to the macOS Keychain. The CLI's
  `set-api-key` and `reset-trial` subcommands also touch Keychain. Anything
  that exposes another app to these items, leaks them to disk, or escalates
  privileges through them is in scope.
- **OAuth blob handling.** Clauge reads the OAuth credentials blob from
  `~/.claude/credentials.json` (mode 0600) and uses the access token to call
  Anthropic's OAuth endpoints (`api.anthropic.com/api/oauth/usage`). Anything
  that leaks, mishandles, or accidentally writes the token elsewhere is in
  scope.
- **The local HTTP server** (`server.js`, bound to `127.0.0.1`). Anything that
  lets a non-localhost origin reach the read-only endpoints, or any
  unauthenticated origin reach `POST /api/usage/ingest`, is in scope. We
  explicitly use wildcard CORS on read-only routes because the listener is
  loopback-only — if that bind changes, the wildcard becomes a regression.
- **The Tauri webview.** Anything that lets a navigation outside the
  allowlisted host:port (see `src-tauri/src/windows.rs::on_navigation`) reach
  the dashboard webview, or that bypasses the `on_new_window` external-URL
  scheme allowlist, is in scope.
- **The Companion CLI** (`clauge` binary). Particularly anything around
  `clauge config set-api-key`'s stdin-only ingestion and `clauge config
  reset-trial`'s three-lock guard.
- **The Chrome extension** (`extension/`, published as Clauge Sync). Anything
  that lets a non-claude.ai page read the extension's storage or trigger an
  ingest with attacker-controlled data is in scope.

Out of scope:

- **Third-party dependencies' upstream vulnerabilities.** Please report those
  to the dependency maintainer directly (we'll track and bump on our end via
  `npm audit` / `cargo audit`).
- **Browser bookmarklet abuse via untrusted execution context.** The
  bookmarklet runs in the user's browser; if the user is already executing
  arbitrary JS on claude.ai (XSS, malicious extension), that's not a Clauge
  vulnerability.
- **Username/email/path leakage in error messages.** Clauge logs may include
  these for debugging local issues; they don't leave the machine.
- **Local-only DoS** (e.g., feeding the parser pathological JSONL). The parser
  is best-effort; users control their own `~/.claude/projects/`.
- **Subjective UI security** (e.g., "the heatmap reveals my activity pattern
  to anyone with my screen"). The user controls their screen.

## v0.10.0 IAP — credential-storage notes

Clauge v0.10.0 will introduce paid-tier entitlement checks that touch
additional Keychain items. Issues that affect credential storage will become
load-bearing for paywall integrity. The v0.10.0 release will publish a
refreshed SECURITY.md with the IAP-specific surface enumerated.

## Acknowledgements

Reporters who follow responsible disclosure get credit in the release notes
unless they prefer otherwise. We don't run a bug bounty program — Clauge is
a side project, not a budgeted product.
