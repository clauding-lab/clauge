# Clauge for iOS — Phase ① Design (standalone Claude.ai dashboard)

**Date:** 2026-06-02
**Status:** Approved design (brainstormed with Adnan) — ready for implementation planning
**Scope:** Phase ① of a phased iOS product. This spec covers ONLY the standalone Claude.ai usage dashboard. Phases ②–④ (Mac mirror, widgets, alerts) are out of scope here but their seams are designed in.

---

## 1. Context

Clauge (desktop) is a Tauri menu-bar app for macOS/Windows that reads **local** Claude Code session logs (`~/.claude/projects/**/*.jsonl`) plus the Claude Code OAuth token, and renders token-usage / plan-ROI analytics — all on-device, no Clauge-operated server.

We want an **iOS app**. The defining constraint: **an iPhone cannot read the Mac's local `~/.claude` logs.** So the iOS data source must be different.

The agreed product is **tiered**:

- **Tier 1 (this spec):** install → log into Claude.ai in-app → a dashboard of *your Claude.ai usage*. Fully standalone, no Mac required.
- **Tier 2 (Phase ②, later):** opt-in in Settings — "tag" your Mac's Claude Code → the dashboard *expands* into deep, desktop-Clauge-style per-session analytics, mirrored from the Mac.
- **Throughout (Phases ③/④, later):** Home-screen **widgets** (glanceable) + usage-limit **push alerts**.

We design **Phase ① first** because it is the foundation everything else hangs off and is independently useful on day one.

## 2. Goals (Phase ①)

- A native iOS app that, after an in-app Claude.ai login, shows the user's **current Claude.ai usage** at a glance: usage-limit burn + reset countdown, plan/credit balance, overage spend.
- No backend, no accounts, no data leaving the device except the calls to Claude.ai itself (preserves Clauge's privacy ethos).
- Resilient to the fact that Claude.ai's usage data comes from **unofficial/internal endpoints**.
- Architected so Phases ②–④ slot in without a rewrite.

## 3. Non-goals (Phase ① — deferred, YAGNI)

- ❌ Mac mirror / deep Claude Code log analytics → **Phase ②**
- ❌ Home-screen widgets → **Phase ③** (App-Group seam laid here)
- ❌ Push notifications / usage alerts → **Phase ④** (background-refresh seam laid here)
- ❌ Historical charts / trends → current snapshot only in v1
- ❌ Any Clauge-operated backend, user accounts, or in-app purchases. **App is free, no IAP** (matches desktop Clauge).

## 4. Key decisions (from the brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Core job | Standalone Claude.ai usage dashboard | Tier 1; useful with zero Mac setup |
| Data source | In-app Claude.ai login → captured web session → Claude.ai **internal** usage endpoints, read-only | Only true-standalone path; Claude.ai has no official usage API |
| Build | **Native SwiftUI** | Best feel; widgets/alerts/login/Keychain are native-only anyway; Apple-review-friendliest |
| Backend | **None** | Preserves Clauge's "no server, your data stays on device" model |
| Distribution | App Store (free), accept defensive design for unofficial-API + review risk | Adnan accepted the risk (option a) |

## 5. Architecture

Native SwiftUI app. No backend. Layers:

```
┌─────────────────────────────────────────────────────────┐
│ SwiftUI views (Dashboard, Connect/Login, Settings)       │
├─────────────────────────────────────────────────────────┤
│ View models (UsageDashboardViewModel, AuthViewModel)     │
├─────────────────────────────────────────────────────────┤
│ UsageSource protocol  ──►  ClaudeAiUsageSource (Phase ①) │
│                            (Phase ② adds MacMirrorSource)│
├──────────────────────┬──────────────────────────────────┤
│ ClaudeAiClient       │ SessionStore (Keychain)           │
│ (internal endpoints) │ + AppGroup shared store (seam)    │
├──────────────────────┴──────────────────────────────────┤
│ WKWebView login flow (capture session cookie)            │
└─────────────────────────────────────────────────────────┘
```

### Components & responsibilities

- **`WebLoginView`** — wraps `WKWebView` loading Claude.ai's real login page. On successful login, reads the `claude.ai` session cookie(s) (e.g. `sessionKey`) from the web view's cookie store. *What it depends on:* WebKit. *Interface:* `onSession(Session)` callback.
- **`SessionStore`** — persists the captured session in the **iOS Keychain** (encrypted, on-device). Read/write/clear. Detects expiry (set by the client on 401/redirect). *No password is ever handled* — only the post-login session.
- **`ClaudeAiClient`** — calls Claude.ai's internal endpoints with the stored session, read-only (GET):
  - list organizations → resolve `{org_uuid}`
  - `GET /api/organizations/{uuid}/usage` → rate-limit / usage utilization
  - `GET /api/organizations/{uuid}/prepaid/credits` (and/or `/credits`) → balance
  - `GET /api/organizations/{uuid}/overage_spend_limit` → overage cap & spend
  - **Source of truth for exact endpoint shapes + headers:** the desktop Clauge browser extension (`extension/background.js` in this repo) already makes these calls successfully — the iOS client should **mirror those request shapes**, not reinvent them. (Confirm exact paths/params against that file during the build.)
- **`UsageSource` protocol** — abstracts "where usage comes from." Phase ① ships `ClaudeAiUsageSource`. Phase ② adds `MacMirrorSource`; the dashboard renders the richer source when present (the "expand" behavior). View models depend only on `UsageSource`, never on `ClaudeAiClient` directly.
- **`UsageDashboardViewModel`** — pulls a `UsageSnapshot` from the active `UsageSource`, exposes display state (loading / loaded / degraded / needs-reconnect), drives refresh.
- **SwiftUI views** — `DashboardView`, `ConnectView` (pre-login), `SettingsView` (sign out; Phase ② "tag a Mac" lands here later).

### Data flow

1. First launch → `ConnectView` → user taps **Connect Claude.ai** → `WebLoginView` → user logs in → session captured → `SessionStore` (Keychain).
2. `ClaudeAiUsageSource` uses the session via `ClaudeAiClient` to fetch a `UsageSnapshot`.
3. `UsageDashboardViewModel` publishes it → `DashboardView` renders.
4. Snapshot is also written to the **App Group shared store** (seam for Phase ③ widgets / Phase ④ alerts).
5. Refresh: pull-to-refresh + on-foreground; a background-refresh hook exists for Phase ④.

## 6. Data model

```
UsageSnapshot {
  fetchedAt: Date
  org: { id, name }
  limits: [ UsageLimit ]        // per window: e.g. session/5h, weekly
  balance: CreditBalance?       // prepaid credits, currency
  overage: OverageStatus?       // spend vs cap
  fieldErrors: [Field: String]  // per-field "couldn't read X" (degradation)
}
UsageLimit { window: String, usedPct: Double, resetsAt: Date? }
CreditBalance { amount, currency }
OverageStatus { spent, cap, currency }
```

`fieldErrors` is central to resilience (§8): each field parses independently.

## 7. The dashboard (Phase ① content)

- **Headline card — usage-limit burn:** the most prominent element. % of limit used per active window + a **reset countdown** ("resets in 3h 12m"). This is the "am I about to get throttled?" glance. Color/tone per Clauge palette (reuse the desktop token spirit; bull/neutral/warn as utilization rises).
- **Plan & balance:** plan tier (if available), prepaid credit balance, overage spend vs. cap.
- **Org switcher:** only shown if the user belongs to >1 org.
- **Freshness:** "as of 2m ago" timestamp; pull-to-refresh; auto-refresh on foreground.
- **States:** loading skeleton; loaded; **degraded** (some `fieldErrors` → show those cards as "unavailable", rest normal); **needs-reconnect** (session expired → CTA to re-login).

## 8. Resilience — surviving the unofficial API

This is the highest-risk area (Anthropic can change/remove the internal endpoints at any time).

- **Per-field graceful degradation:** parse each metric independently; a changed/missing field populates `fieldErrors[field]` and that one card shows "unavailable" — the rest of the dashboard keeps working. **Never** let one parse failure blank the whole screen.
- **Session expiry:** a 401 or a redirect to the login page → mark session expired in `SessionStore` → dashboard shows **needs-reconnect** with a one-tap re-login.
- **Honesty (Clauge house style):** every number carries its `fetchedAt`; never present stale data as fresh. A quiet "Source: Claude.ai" note. If nothing can be read, say so plainly — don't fabricate.
- **Centralized endpoint config:** all Claude.ai base URLs + paths live in one file/struct, so a future Anthropic change is a one-file patch (and easy to keep in sync with `extension/background.js`).
- **No silent failures:** surface errors to the user (and log locally); do not swallow.

## 9. Testing

- **`ClaudeAiClient` parsing** against saved JSON **fixtures** captured from the real endpoints → catches endpoint drift without a live-Claude.ai dependency in CI. Include a fixture with a missing/renamed field to assert per-field degradation.
- **`SessionStore`** Keychain round-trip + expiry handling.
- **View-model logic:** usage-% math, reset-countdown formatting, state transitions (loading→loaded→degraded→needs-reconnect).
- Optional: SwiftUI snapshot tests for the dashboard cards.

## 10. Seams for later phases (designed now, not built)

- **App Group shared store:** `UsageSnapshot` is written to a shared container so Phase ③ **widgets** (WidgetKit) and Phase ④ **alerts** read the same data without re-fetching.
- **`UsageSource` protocol:** Phase ② adds a `MacMirrorSource` (deep analytics synced from the Mac). The dashboard renders the richer source when present → the "expand into desktop-Clauge depth" behavior. The Mac→iOS sync mechanism (and its privacy implications — likely needs a sync channel, a departure from local-only) is a **Phase ② design**, not decided here.
- **Background-refresh hook:** a refresh entry point Phase ④ can invoke to check "near limit" and fire a local/push notification. (No notifications in Phase ①.)
- **Settings screen** exists in Phase ① (sign out); Phase ② adds the "tag a Mac" flow here.

## 11. Open questions / decisions deferred to build or later phases

- **Repo placement:** does the iOS app live in a **new `clauge-ios` repo** or an **`ios/` subdir of `clauge`**? Recommendation: a separate `clauge-ios` repo (distinct Xcode/SwiftUI toolchain from the Tauri desktop), with this spec cross-referenced. Decide at build kickoff.
- **Exact endpoint contracts:** confirm against `extension/background.js` on the Mac during build (it has the working calls).
- **Multi-account / org edge cases:** basic org switcher in v1; richer handling later if needed.
- **Apple review framing:** present as read-only access to the user's *own* account data; have a fallback (TestFlight) if review balks.

## 12. Build & handoff notes

- **This app must be built on a Mac** (Xcode, SwiftUI, iOS simulator/device, code signing) — the VPS cannot compile iOS.
- Handoff: this spec + the implementation plan (next) are committed to the repo. A Claude Code session **on the Mac** reads them and builds via the executing-plans flow, with verification checkpoints — not a one-shot prompt.
- Reuse the desktop Clauge's proven Claude.ai endpoint calls (`extension/background.js`) and design language (`docs/design/tokens.css`) rather than reinventing.
