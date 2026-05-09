# Design: Auto-detect Clauge Sync Extension (Clauge v0.5.1)

**Date:** 2026-05-09
**Author:** brainstorming session
**Status:** approved, ready for implementation plan
**Target version:** v0.5.1 (app) + v0.1.8 (extension)
**Ship order:** extension v0.1.8 to Chrome Web Store FIRST → wait for review approval (1-3 days) → app v0.5.1 tag

## Problem

Clauge v0.5.0 ships with the Clauge Sync Chrome extension already published
to the Chrome Web Store
(`https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga`),
but the dashboard has no way to detect whether it's installed in the user's
current browser. New users open the dashboard, see empty "claude.ai plan
rings" (or fallback "—"), and have no in-product guidance to install the
extension. The README documents the install path, but the dashboard itself
provides no friction-free CTA, status indicator, or first-run onboarding for
the extension.

The result: a portion of new users either give up on claude.ai data, or
spend time navigating to the Settings → claude.ai sync card to discover the
bookmarklet, without knowing the extension exists.

## Decision

Add a two-layer detection system + dashboard banner so users with the
extension *not installed* see a clear in-product prompt with a one-click
install link, and users with the extension *installed* see a status row in
Settings confirming it's working.

Detection combines:
- **Layer 1 (heartbeat)**: server tracks the timestamp of the most recent
  POST to `/api/usage/ingest`; exposes via `/api/health`.
- **Layer 2 (page marker)**: extension v0.1.8 adds a content script that
  injects `window.__claugeSyncInstalled = '<version>'` into the dashboard
  page. Dashboard reads it on load.

Layer 2 is authoritative when present (zero false positives); Layer 1 is
the graceful-degradation fallback for users still on extension v0.1.7.

## Scope

**Adds (extension):**
- `extension/manifest.json`: bump version `0.1.7 → 0.1.8`; new
  `content_scripts` entry matching `http://localhost/*` and
  `http://127.0.0.1/*`
- `extension/content-dashboard.js`: new file (~10 lines) that injects
  `window.__claugeSyncInstalled = '<version>'` via `<script>` tag (standard
  MV3 isolated-world → page-world bridge pattern)

**Adds (server):**
- `server.js`: module-level mutable `let lastIngestAt = null`; updated by
  `/api/usage/ingest` POST handler; exposed by `/api/health` as
  `extensionLastSeenAt: <ISO 8601 string | null>`

**Adds (dashboard):**
- `public/app.js`: detection logic on dashboard load; banner render +
  dismissal handling; Settings → claude.ai sync card status row
- `public/index.html`: banner DOM scaffold; status-row DOM scaffold inside
  the existing claude.ai sync settings panel
- `public/styles.css`: banner + status-row styling

**Modifies (versioning):**
- `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`,
  `popover/index.html`, `popover/popover.js`, `public/index.html`:
  bump version `0.5.0 → 0.5.1`

**Unchanged:**
- All Claude Code CLI parsing logic (`lib/parser.js`, `lib/aggregator.js`,
  etc.)
- The bookmarklet code (`lib/bookmarklet.js`, `/api/bookmarklet` endpoint,
  Settings panel draggable bookmarklet UI) — kept as a power-user fallback
  even though no longer surfaced in the README install walkthrough
- Existing extension files (`background.js`, `content-platform.js`,
  `popup.js`, `options.js`, `popup.html`, `options.html`)
- macOS popover surface (`popover/index.html`, `popover/popover.css`,
  `popover/popover.js`) — popover is glanceable, not for setup; install
  CTA lives only in the dashboard
- All Tauri plugins, the auto-updater flow, and the SEA sidecar build

**Out of scope (deliberately):**
- Firefox or non-Chromium extension build — defer until requested
- Banner animation / polish beyond a clean static block
- Granular dismissal options ("snooze 30 days," "never show again") — a
  7-day re-prompt cadence + auto-detect-positive flip is sufficient
- Telemetry on banner impressions / click-through — Clauge has no telemetry
  by design, this preserves that
- Dynamically-rendered Windows tray icon with % chiclet (separate v0.6.x or
  later concern, unrelated to extension detection)
- Extension auto-update path — Chrome Web Store handles this for users who
  installed via CWS; users on dev-mode `Load unpacked` must update manually

## Architecture

### Detection mechanism

**Layer 1 — Heartbeat (server-side):**

The extension's `background.js` already runs a `chrome.alarms`-driven
60-second poll that fetches claude.ai usage and POSTs to
`http://localhost:3456/api/usage/ingest`. Server records `lastIngestAt =
Date.now()` on every successful ingest. `/api/health` returns
`extensionLastSeenAt` as an ISO 8601 string (or `null` if never seen).

In-memory only — survives until the server process restarts. Acceptable
because the heartbeat re-fires within ~1 minute of the user opening
claude.ai. No persistence file needed.

**Layer 2 — Page marker (browser-side):**

Extension v0.1.8 manifest adds a new `content_scripts` entry:

```json
{
  "matches": ["http://localhost/*", "http://127.0.0.1/*"],
  "js": ["content-dashboard.js"],
  "run_at": "document_idle"
}
```

`extension/content-dashboard.js` runs in the isolated world (default for
MV3 content scripts). To make a value visible to the dashboard page's JS
context (the page world), it injects a `<script>` tag:

```js
const version = chrome.runtime.getManifest().version;
const tag = document.createElement('script');
tag.textContent = `window.__claugeSyncInstalled = ${JSON.stringify(version)};`;
(document.head || document.documentElement).appendChild(tag);
tag.remove();
```

Why the `<script>` tag injection: in MV3, `world: "MAIN"` would let us
write directly to `window` from the content script, but loses access to
`chrome.runtime.getManifest()`. The isolated-world script-tag-injection
pattern is the standard MV3 idiom that gets both: read manifest version
from the isolated-world context, write to page-world `window`.

The injected `<script>` is removed from the DOM immediately after
execution. The `window.__claugeSyncInstalled` value persists.

**Combined decision logic (in `public/app.js`):**

```js
function detectExtension() {
  if (typeof window.__claugeSyncInstalled === 'string') {
    return { state: 'INSTALLED_ACTIVE', version: window.__claugeSyncInstalled };
  }
  // Fallback: heartbeat-only signal (extension v0.1.7 OR unsupported browser
  // that hasn't yet loaded content-dashboard.js).
  const lastSeen = window.__claugeHealthExtensionLastSeenAt;
  if (lastSeen && (Date.now() - new Date(lastSeen).getTime()) < 10 * 60 * 1000) {
    return { state: 'INSTALLED_INACTIVE', version: 'unknown' };
  }
  return { state: 'NOT_DETECTED' };
}
```

The `lastSeen` value is hydrated from `/api/health` on dashboard load (the
existing health poll picks it up). The `__claugeHealthExtensionLastSeenAt`
global is set by the same code that handles the existing health response.

### Dashboard UX

**Top-of-dashboard banner (every tab, dismissible):**

When `detectExtension().state === 'NOT_DETECTED'` AND not within the
7-day dismissal window, render a banner at the top of `<body>`, above all
tab content:

```
┌──────────────────────────────────────────────────────────────────────┐
│ ⓘ See your claude.ai plan rings — install Clauge Sync                │
│ A 1-click browser extension that syncs claude.ai data to Clauge.     │
│ [Install Clauge Sync]                                          [×]   │
└──────────────────────────────────────────────────────────────────────┘
```

- Primary button "Install Clauge Sync" → opens `https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga` in a new tab
- Dismiss `×` → stores `clauge.extension_dismissed_at = Date.now()` in
  `localStorage`. Stays dismissed for 7 days, then auto-re-prompts unless
  detection has flipped positive in the meantime
- `localStorage` works across both the Tauri webview surface and the
  `npx clauge` browser dashboard (same `localhost:<port>` origin)
- If detection flips to `INSTALLED_ACTIVE` while the banner is showing
  (e.g., user installs the extension in a new tab without reloading the
  dashboard), the banner hides immediately. Re-detection runs on the
  existing dashboard health/refresh poll cycle plus on `window.focus`
  events. (Implementation plan will pick the exact cadence based on the
  existing app.js polling structure.)

**Settings → claude.ai sync card status row (always visible):**

Inside the existing claude.ai sync settings panel (`public/index.html:406`),
a status line at the top:

| Detection state | Status row |
|---|---|
| `INSTALLED_ACTIVE` | 🟢 `Clauge Sync v0.1.8 — last sync 23s ago` |
| `INSTALLED_INACTIVE` | 🟡 `Clauge Sync detected, but no recent sync. Open claude.ai in this browser to refresh.` |
| `NOT_DETECTED` | 🔴 `Not detected. [Install Clauge Sync →]` |

The status row updates live on each health poll. Time-since text ("23s
ago") uses a one-second timer if the panel is currently visible, else
re-renders on tab switch.

**No popover prompt on macOS:**

The popover is a glanceable surface, not an onboarding surface. The
existing "—" placeholder for missing claude.ai data is left as the
implicit "something's off here, check the dashboard" signal. Adding an
install CTA inside a 360pt popover would clutter the rings.

### Server changes

`server.js`:

```js
// Module-level mutable. Updated by /api/usage/ingest POST handler.
let lastIngestAt = null;

app.post('/api/usage/ingest', async (c) => {
  // ... existing validation + persist logic ...
  lastIngestAt = Date.now(); // NEW: record heartbeat
  return c.json({ /* existing response */ });
});

app.get('/api/health', (c) =>
  c.json({
    service: 'clauge',
    status: 'ok',
    version: APP_VERSION,
    pid: process.pid,
    claudeDir: CLAUDE_DIR,
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    subscriptionCost: SUBSCRIPTION_COST,
    extensionLastSeenAt: lastIngestAt
      ? new Date(lastIngestAt).toISOString()
      : null, // NEW
  })
);
```

The `extensionLastSeenAt` is emitted as ISO 8601 (string) for human
readability + JSON-stringify safety. Server keeps it in `Date.now()`
milliseconds internally to avoid repeated parsing.

### Extension changes (v0.1.7 → v0.1.8)

`extension/manifest.json`:
- `"version": "0.1.7"` → `"0.1.8"`
- `host_permissions` already includes `http://localhost/*` and
  `http://127.0.0.1/*` (verified — no manifest change here)
- `content_scripts` adds new entry alongside the existing
  `platform.claude.com` entry:

```json
"content_scripts": [
  {
    "matches": ["https://platform.claude.com/*"],
    "js": ["content-platform.js"],
    "run_at": "document_idle"
  },
  {
    "matches": ["http://localhost/*", "http://127.0.0.1/*"],
    "js": ["content-dashboard.js"],
    "run_at": "document_idle"
  }
]
```

`extension/content-dashboard.js` (new file, ~10 lines, content shown in
"Architecture" section above).

CWS resubmission required. The new content script fires on `localhost`
URLs, which is a permission-shape change CWS reviewers will look at.
Risk: minor. Justification documented in the listing description: "Detects
whether Clauge dashboard is open so it can show installation status to
the user."

### Versioning + ship sequence

**Two artifacts ship together but in order:**

1. **Extension v0.1.8** — manifest update + new content script. Submit to
   Chrome Web Store via the developer dashboard. Wait for review approval
   (1-3 days typical for minor manifest changes).
2. **App v0.5.1** — once extension v0.1.8 is live in CWS, tag `v0.5.1`.
   GHA builds + signs the DMG + auto-updater payload. The Tauri auto-
   updater rolls v0.5.0 users to v0.5.1 on next launch.

**Graceful degradation if app ships before extension review completes:**

The dashboard's Layer 1 (heartbeat) detection still works for users who
have v0.1.7 of the extension. They'd see `INSTALLED_INACTIVE` only if they
haven't visited claude.ai recently, otherwise `INSTALLED_ACTIVE` (with
"version: unknown" until they update to v0.1.8). Banner only shows for
users who have neither layer's signal — i.e., users with no extension at
all. Those users get the right CTA regardless of extension review state.

**v0.6.0 Windows port** stays planned exactly as it is in
`docs/superpowers/plans/2026-05-09-windows-implementation-plan.md`. Its
Phase 5 "Version bump" task currently bumps `0.5.0 → 0.6.0`; that becomes
`0.5.1 → 0.6.0` at execution time. Trivial fix.

## Decisions made

| # | Decision | Reason |
|---|---|---|
| 1 | Ship v0.5.1 BEFORE v0.6.0 Windows port | Smaller, lower-risk, fully macOS-side. Validates the cadence without matrix-CI complexity. |
| 2 | Two-layer detection (heartbeat + page marker) | Layer 2 is authoritative; Layer 1 is graceful degradation for users still on v0.1.7. Single layer alone is either fragile (Layer 1: false negatives if user hasn't visited claude.ai today) or non-portable (Layer 2: requires extension version bump). |
| 3 | Banner at top of dashboard, every tab, dismissible | Most visible placement without modal aggression. Matches GitHub repo banner style users already understand. |
| 4 | 7-day re-prompt cadence after dismissal | Balances "don't be annoying" with "user might have forgotten." Auto-cancels if detection flips positive. |
| 5 | Settings card status row always visible | Persistent signal for users who *do* go look at Settings; complements the banner without depending on it. |
| 6 | No popover install CTA on macOS | Popover is glanceable, not for setup. The "—" placeholder for missing data is the implicit nudge. |
| 7 | `localStorage` for dismissal flag, not Tauri store | Works across both Tauri webview AND `npx clauge` browser dashboard surfaces (same `localhost` origin). Tauri-specific store would only cover one surface. |
| 8 | `lastIngestAt` in-memory, not persisted | Heartbeat re-fires within 1 minute when claude.ai is open. Persistence file would add complexity for marginal benefit. |
| 9 | Bookmarklet code stays, only README mention removed | Power-user fallback for users who hit a CWS-region restriction or want a non-installed sync mechanism. The Settings UI still surfaces it. |
| 10 | Banner also shows in `npx clauge` browser-only path | Same `public/app.js` code path; banner CSS works in any browser. Tauri webview gets no special treatment, and a `npx clauge` user without the extension benefits from the same install CTA. |

## Open questions

- **Browser support beyond Chrome**: the extension is published to the
  Chrome Web Store; Edge, Brave, Arc, Opera, Vivaldi all support CWS
  installs. Firefox does not (would need addons.mozilla.org submission).
  Defer Firefox until requested. Document in README that "Chromium-based
  browsers" are supported.
- **Localhost origin variance**: dashboards bound to a non-default port
  (`PORT=3457`) still match `http://localhost/*` and `http://127.0.0.1/*`
  patterns (the CWS host-pattern format ignores port). ✅ Verified.
- **Dashboard is sometimes accessed via `http://0.0.0.0:3456`?** Not
  currently — the `npx clauge` open-browser auto-launches `localhost:3456`,
  and the Tauri webview loads `127.0.0.1:<port>`. If a user types
  `0.0.0.0` manually, Layer 2 detection won't fire. Acceptable edge case.

## Definition of done

- [ ] Extension v0.1.8 published to Chrome Web Store (CWS listing version
      shows 0.1.8)
- [ ] Loading the dashboard at `http://localhost:3456` with v0.1.8
      installed sets `window.__claugeSyncInstalled = '0.1.8'` (verifiable
      in DevTools Console)
- [ ] `/api/health` returns `extensionLastSeenAt` field (null on cold
      start; ISO timestamp after first ingest)
- [ ] Dashboard banner appears on first launch when extension not detected
- [ ] Banner "Install Clauge Sync" button opens the CWS listing in a new tab
- [ ] Banner `×` dismiss persists across reloads (verifiable in DevTools
      → Application → Local Storage → `clauge.extension_dismissed_at`)
- [ ] After 7 days OR after detection flips positive, banner re-shows /
      auto-hides accordingly
- [ ] Settings → claude.ai sync panel shows correct status row (🟢 / 🟡 /
      🔴) for each detection state
- [ ] App v0.5.1 DMG built + signed + published via tagged GHA run
- [ ] gh-pages `latest.json` updated to v0.5.1; macOS Tauri auto-updater
      successfully prompts v0.5.0 install for upgrade
- [ ] No regression in v0.5.0 macOS smoke (popover persists, dashboard
      opens, etc.)
- [ ] No regression in `npx clauge` browser dashboard (banner + status
      row also work in Chrome/Edge/Brave outside the Tauri webview)
