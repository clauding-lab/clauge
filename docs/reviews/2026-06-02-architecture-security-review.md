# Clauge (desktop) — Architecture & Security Review

**Date:** 2026-06-02
**Version reviewed:** v0.9.10 (Mac App Store approved & live; DMG + Windows)
**Method:** full read of the Rust backend (`src-tauri/src/*.rs`), the Node sidecar (`server.js`, `lib/*`), the browser extension, entitlements/capabilities, and the docs/governance set.
**Purpose:** record the findings — especially security — and a prioritized backlog of what matters to examine and fix in future updates.

---

## Verdict

A genuinely well-engineered, privacy-honest, **exceptionally well-governed** pre-1.0 tool. The MAS approval and the rejection-saga discipline put it ahead of most solo projects. The security posture is sound **for its stated threat model** (a trusted single-user developer machine); the items below are about making that boundary explicit and tightening the edges before the user base grows.

## What's strong (keep)

- **Local-only architecture, correctly implemented** — no Clauge-operated server. The sidecar binds to `127.0.0.1` (not `0.0.0.0`), and the bind + wildcard-CORS coupling is called out in a load-bearing code comment. `PRIVACY.md` matches the code.
- **Token redaction** — `ClaudeAiOauth`'s `Debug` impl redacts `access_token`/`refresh_token`, preventing log leakage.
- **No cost trust from logs** — costs are recomputed from tokens × rate, never read from the JSONL `costUSD` (good hygiene).
- **MAS sandbox** — security-scoped bookmarks, minimal scope (pre-selects `~/.claude`, not `/`), `ScopedHandle::Drop` releases access.
- **Crash circuit-breaker** on the sidecar supervisor (silent respawn → notify → exponential backoff).
- **`proxy_fetch` guard** — only `/api/` paths, GET-only, 10 MiB cap.
- **Governance triad** — `AGENTS.md` (29 landmines) + `AGENT_LEARNINGS.md` (8 post-mortems) + `VISION.md` sign-off matrix. Each Apple rejection was diagnosed to root cause and codified.

---

## Security findings

Severity is relative to the **local threat model** (the whole posture assumes no malicious local process on the machine).

| # | Finding | Where | Severity |
|---|---|---|---|
| S1 | **Stale OAuth token not invalidated on 401.** Cache keeps serving a rotated token until manual Refresh — a documented but unfixed gap since v0.7.2. Also a real *functional* bug (stale data after token rotation). | `anthropic_oauth.rs:~183` | **High (functional + correctness)** |
| S2 | **Unauthenticated localhost server + wildcard CORS.** Any local process / browser tab / extension can `GET` session data — including **shell-command names and absolute project paths** (`/api/sessions` → `filePath`) and `claudeDir` (`/api/health`) — with zero auth. | `server.js` | **Med (local-info disclosure)** |
| S3 | **`chrome-extension://` ingest CORS not pinned.** `/api/usage/ingest` accepts *any* `chrome-extension://` origin (extension ID not pinned) → a malicious/compromised extension can inject false usage data. | `server.js` `isAllowedIngestOrigin` | **Med (data integrity / spoofing)** |
| S4 | **`CLAUGE_ANTHROPIC_BASE_URL` env override.** Overrides `https://api.anthropic.com`; a process that can set env for Clauge could redirect the OAuth Bearer token to an attacker server. Intentional test hatch, but undocumented as security-sensitive. | `anthropic_oauth.rs::base_url()` | **Med (token exfiltration vector)** |
| S5 | **LiteLLM pricing fetched from unpinned `main`.** `raw.githubusercontent.com/BerriAI/litellm/main/...` with no checksum/commit pin → a repo compromise or force-push yields silently wrong costs. No code-exec path; data-integrity only. | `lib/cost-calculator.js` | **Low (integrity)** |
| S6 | **DMG entitlement `cs.disable-library-validation = true`.** Broadest Hardened-Runtime entitlement; allows loading unsigned dylibs in a process that holds Keychain tokens. Standard for Node-SEA but worth confirming it's strictly necessary. | `entitlements.dmg.plist` | **Low (hardening)** |
| S7 | **Port file world-readable.** `~/Library/Caches/Clauge/active-port` (default 0644) — any local user can find the sidecar port. Consistent with the existing "all local processes can read" posture. | `port_file.rs` | **Low** |

**The single biggest consideration:** the DMG (non-sandboxed) flavor runs as the user's full-privilege process, holds the Claude Code OAuth token (and a claude.ai session cookie) in memory, and exposes session metadata over an **unauthenticated** localhost server. The architecture is sound *if* no other process on the machine is malicious — but that assumption is currently **implicit**. It should be made explicit, and the write/sensitive endpoints tightened.

---

## Prioritized backlog — what to fix in future updates

1. **[S1 · do first] Invalidate the token cache on 401.** Wire `keychain_cache.invalidate()` into the `TokenExpired` path so a rotated Claude Code token self-heals without a manual Refresh. Highest user-facing value; already scoped (was slated for v0.8.0).
2. **[S2/S3 · security hardening pass] Lock down the localhost server.**
   - Add a **per-session HMAC/token** shared between the Tauri shell and the sidecar, required on write + sensitive endpoints (`/api/usage/ingest`, `/api/sessions`).
   - **Pin the extension ID** for `/api/usage/ingest` (don't accept any `chrome-extension://`).
   - **Drop path leakage** from public responses: omit `claudeDir` from `/api/health` and `filePath` from `/api/sessions`.
   - **Document the threat model** explicitly in `SECURITY.md`: "trusted single-user machine; localhost server assumes no hostile local process."
3. **[S4] Document `CLAUGE_ANTHROPIC_BASE_URL`** as security-sensitive; consider gating it to debug builds only.
4. **[S5] Pin the LiteLLM pricing source** to a commit hash (or ship a vendored fallback + checksum) instead of `main`.
5. **[S6] Re-examine `disable-library-validation`** on DMG — confirm it's required by the Node-SEA load path; document why if kept.
6. **[robustness] Heatmap fixture regression test.** The "HTML loads facade-using JS before the facade" bug class bit twice in 24h; the dashboard heatmap still lacks a fixture regression test. Add one.
7. **[platform] Windows is incomplete** — finish or clearly scope it. **v0.10.0 IAP** work is the next major complexity inflection — treat as its own design/spec.

---

## Notes

- This review informed the **Clauge iOS** design (see `docs/superpowers/specs/2026-06-02-clauge-ios-phase1-design.md`): the iOS app reuses the desktop's Claude.ai endpoint contracts (`extension/background.js`) and design tokens, and inherits the same "honesty about data freshness" discipline.
- None of the findings are remote-exploitable as shipped; they are local-privilege / integrity / robustness items. Address S1 first (it's also a plain bug), then the S2/S3 hardening pass before the user base grows.
