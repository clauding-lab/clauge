# Auto-detect Clauge Sync Extension (v0.5.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two-layer Clauge Sync extension detection (server heartbeat + browser-side window global) plus a top-of-dashboard install banner and Settings status row, shipped as Clauge v0.5.1 + extension v0.1.8.

**Architecture:** Extension v0.1.8 adds a content script that injects `window.__claugeSyncInstalled = '<version>'` on the dashboard origin. Server tracks `lastIngestAt` and exposes it via `/api/health`. Dashboard combines both signals to render a dismissible install banner and a 3-state Settings status row (active/inactive/not-detected).

**Tech Stack:** Node 22 + Hono (server), Manifest V3 Chrome extension, vanilla JS dashboard, Node's built-in `node:test` for unit tests, manual browser smoke for UI.

**Reference spec:** `docs/superpowers/specs/2026-05-09-extension-autodetect-design.md`

**Ship order:** Extension v0.1.8 → Chrome Web Store review (1-3 days) → app v0.5.1 tag.

---

## Phase 1: Extension v0.1.8 (local)

### Task 1: Update extension manifest

**Files:**
- Modify: `extension/manifest.json`

- [ ] **Step 1: Read the current manifest**

```bash
cat extension/manifest.json
```

Confirm current `"version": "0.1.7"` and the existing `content_scripts` entry that matches `https://platform.claude.com/*`.

- [ ] **Step 2: Update the manifest**

Replace `extension/manifest.json` with:

```json
{
  "manifest_version": 3,
  "name": "Clauge Sync",
  "version": "0.1.8",
  "description": "Auto-sync claude.ai plan usage to your local Clauge dashboard. Polls every minute, click the toolbar to sync now.",
  "homepage_url": "https://github.com/clauding-lab/clauge",
  "author": "clauding-lab",
  "icons": {
    "16": "icons/icon-16.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    "default_title": "Clauge Sync"
  },
  "permissions": ["alarms", "storage"],
  "host_permissions": [
    "https://claude.ai/*",
    "https://platform.claude.com/*",
    "https://console.anthropic.com/*",
    "http://localhost/*",
    "http://127.0.0.1/*"
  ],
  "background": {
    "service_worker": "background.js"
  },
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
  ],
  "options_ui": {
    "page": "options.html",
    "open_in_tab": false
  }
}
```

Changes from v0.1.7:
- `"version": "0.1.7"` → `"0.1.8"`
- `content_scripts` array gains a second entry for localhost dashboards

`host_permissions` already includes `http://localhost/*` and
`http://127.0.0.1/*` (no change there).

- [ ] **Step 3: Validate JSON syntax**

```bash
node -e "JSON.parse(require('fs').readFileSync('extension/manifest.json', 'utf8'))" && echo "OK"
```

Expected: prints `OK`. If it errors, fix the JSON syntax issue.

- [ ] **Step 4: Commit**

```bash
git add extension/manifest.json
git commit -m "$(cat <<'EOF'
feat(extension): v0.1.8 manifest — add localhost content_scripts entry

Bump extension version 0.1.7 → 0.1.8 and register a new content script
that runs on http://localhost/* and http://127.0.0.1/* (the Clauge
dashboard origin). The content script will inject a window global so the
dashboard can detect the extension is installed. Other manifest fields
(host_permissions, options_ui, action, background) unchanged.
EOF
)"
```

---

### Task 2: Create content-dashboard.js

**Files:**
- Create: `extension/content-dashboard.js`

The content script runs in the isolated world (default for MV3). To make
a value visible to the page's JS context (where the dashboard's `app.js`
runs), we inject a `<script>` tag whose textContent runs in the page world.
The script sets `window.__claugeSyncInstalled` to the extension's manifest
version, then is removed from the DOM.

- [ ] **Step 1: Create the file**

Write `extension/content-dashboard.js` with this exact content:

```javascript
// Clauge Sync — dashboard detection content script.
//
// Runs at document_idle on http://localhost/* and http://127.0.0.1/*.
// Exposes the extension's manifest version to the dashboard page's JS
// context via window.__claugeSyncInstalled.
//
// MV3 isolated-world note: content scripts cannot directly write to the
// page's window object. We inject a <script> tag whose textContent runs
// in the page world; that script assigns the global. The <script> tag is
// removed from the DOM immediately after execution. The assigned value
// persists.

(() => {
  try {
    const version = chrome.runtime.getManifest().version;
    const tag = document.createElement('script');
    tag.textContent =
      'window.__claugeSyncInstalled = ' + JSON.stringify(version) + ';';
    (document.head || document.documentElement).appendChild(tag);
    tag.remove();
  } catch (e) {
    // Defensive: if injection fails for any reason (e.g. CSP), the
    // dashboard's Layer 1 (heartbeat) detection still works.
    console.warn('[Clauge Sync] dashboard detection injection failed', e);
  }
})();
```

- [ ] **Step 2: Verify file exists and is well-formed**

```bash
node -e "
const src = require('fs').readFileSync('extension/content-dashboard.js', 'utf8');
new Function(src);  // Throws on syntax error.
console.log('OK,', src.length, 'bytes');
"
```

Expected: prints `OK, ~700 bytes`. (The `new Function(src)` parse-checks
without executing.)

- [ ] **Step 3: Commit**

```bash
git add extension/content-dashboard.js
git commit -m "$(cat <<'EOF'
feat(extension): content-dashboard.js for v0.1.8 dashboard detection

New content script that runs on http://localhost/* and http://127.0.0.1/*
and injects window.__claugeSyncInstalled = '<manifest version>' into the
dashboard page. Uses the standard MV3 isolated-world → page-world script-
tag injection pattern (the content script's own globals are not visible to
the page; a transiently-appended <script> tag bridges the worlds).
EOF
)"
```

---

### Task 3: Manual local smoke — load unpacked extension v0.1.8

**Files:** none modified — verification only.

This task verifies the new content script actually injects the expected
global. It must be done manually because it requires Chrome's
`chrome://extensions` UI.

- [ ] **Step 1: Start the dashboard server**

```bash
cd /Users/adnanrashid/Projects/clauge && PORT=3456 node server.js
```

Server should print `Listening on http://localhost:3456` (or similar).
Leave running.

- [ ] **Step 2: Load the unpacked extension**

In Chrome (or Edge/Brave/Arc):
1. Open `chrome://extensions`
2. Toggle **Developer mode** (top-right) ON if not already
3. If Clauge Sync is already loaded (CWS install or prior unpacked), note
   its current version. To verify the new code, click **Remove**, then
4. Click **Load unpacked** → select
   `/Users/adnanrashid/Projects/clauge/extension/`
5. Confirm the loaded card shows `Clauge Sync 0.1.8`

- [ ] **Step 3: Open the dashboard and verify the global**

1. Navigate to `http://localhost:3456` in the SAME browser profile
2. Open DevTools → Console
3. Run: `window.__claugeSyncInstalled`
4. Expected: `'0.1.8'`

If the value is undefined:
- Reload the dashboard page (Cmd+R) — content scripts only inject on
  navigation, not on dynamic page changes
- Verify the extension card still shows `0.1.8` and "Errors: none"
- Re-check that the URL is `http://localhost/*` (not `http://0.0.0.0/*`
  or similar)

- [ ] **Step 4: No commit** — verification gate only.

If smoke fails, return to Task 2 and fix the content script. If smoke
passes, Phase 1 is complete; the extension is locally working.

---

## Phase 2: Server heartbeat

### Task 4: Add `lastIngestAt` tracking + `/api/health` field (TDD)

**Files:**
- Modify: `server.js`
- Test: `test/server-additions.test.js`

The server tracks the timestamp of the most recent successful POST to
`/api/usage/ingest` and exposes it via `/api/health` as
`extensionLastSeenAt` (ISO 8601 string, or `null` if never seen).

- [ ] **Step 1: Add a failing test**

Append to `test/server-additions.test.js` (after the existing
`describe(...)` blocks). First read the existing file to find a good
insertion point — the file already has helpers like `startServer` and
`stopServer`; reuse them.

```javascript
describe('GET /api/health — extensionLastSeenAt heartbeat', () => {
  it('returns null on cold start, then ISO timestamp after ingest', async () => {
    const child = await startServer({ PORT: '3510' });
    try {
      // Cold start — no ingest has happened yet.
      const r1 = await fetch('http://127.0.0.1:3510/api/health');
      const h1 = await r1.json();
      assert.equal(h1.extensionLastSeenAt, null,
        'extensionLastSeenAt is null before any ingest');

      // POST a minimal valid ingest body.
      const ingestRes = await fetch('http://127.0.0.1:3510/api/usage/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The ingest CORS handler accepts requests from claude.ai +
          // chrome-extension origins. Tests run server-side; no Origin
          // header is sent; the route's middleware allows that path.
        },
        body: JSON.stringify({ usage: { five_hour_limit_pct: 0 } }),
      });
      assert.equal(ingestRes.status, 200, 'ingest POST succeeds');

      // Health should now report a recent timestamp.
      const r2 = await fetch('http://127.0.0.1:3510/api/health');
      const h2 = await r2.json();
      assert.ok(h2.extensionLastSeenAt,
        'extensionLastSeenAt is set after ingest');
      const ts = Date.parse(h2.extensionLastSeenAt);
      assert.ok(!Number.isNaN(ts),
        'extensionLastSeenAt is a valid ISO 8601 string');
      assert.ok(Date.now() - ts < 5000,
        'extensionLastSeenAt is within the last 5 seconds');
    } finally {
      await stopServer(child);
    }
  });
});
```

(`startServer` and `stopServer` are existing helpers in the file; the
exact test patterns for spawning the server and posting to `/api/usage/ingest`
are taken from the existing `describe('POST /api/usage/ingest persistence')`
block in the same file.)

- [ ] **Step 2: Run the test — should fail**

```bash
npm test -- --test-name-pattern="extensionLastSeenAt heartbeat"
```

Expected: FAIL — either `h1.extensionLastSeenAt is undefined` or the
field is missing from the response. The exact error depends on the
existing health-endpoint shape.

- [ ] **Step 3: Implement the heartbeat in `server.js`**

Find the line that creates the Hono `app` (early in the file, near the
imports). Add a module-level `let lastIngestAt = null;` immediately after
the constants block (the lines that define `PORT`, `CLAUDE_DIR`,
`SUBSCRIPTION_COST`).

Then find the `/api/health` GET handler (around line 200):

```js
app.get('/api/health', (c) =>
  c.json({
    service: 'clauge',
    status: 'ok',
    version: APP_VERSION,
    pid: process.pid,
    claudeDir: CLAUDE_DIR,
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    subscriptionCost: SUBSCRIPTION_COST,
  })
);
```

Replace with:

```js
app.get('/api/health', (c) =>
  c.json({
    service: 'clauge',
    status: 'ok',
    version: APP_VERSION,
    pid: process.pid,
    claudeDir: CLAUDE_DIR,
    pricing: { source: priceTable.source, fetchedAt: priceTable.fetchedAt },
    subscriptionCost: SUBSCRIPTION_COST,
    // v0.5.1: extension-detection heartbeat. Updated by /api/usage/ingest.
    // null on cold start; ISO 8601 string after first successful ingest.
    extensionLastSeenAt: lastIngestAt
      ? new Date(lastIngestAt).toISOString()
      : null,
  })
);
```

Find the `/api/usage/ingest` POST handler (around line 463). The handler
calls `usageStore.save(...)` (or similar) before responding. Add
`lastIngestAt = Date.now();` immediately AFTER the persist call succeeds
and BEFORE the 200 response is sent. The exact insertion point depends on
the current handler structure — read lines 463-510 of `server.js` and
place the assignment after the line that confirms the ingest succeeded.

Conservative pattern (works regardless of exact handler shape):

```js
app.post('/api/usage/ingest', async (c) => {
  // ... existing validation, parse body, call usageStore.save(...) ...

  lastIngestAt = Date.now();  // v0.5.1: record extension heartbeat

  // ... existing 200 response ...
});
```

- [ ] **Step 4: Run the test — should pass**

```bash
npm test -- --test-name-pattern="extensionLastSeenAt heartbeat"
```

Expected: PASS.

- [ ] **Step 5: Run the full test suite to confirm no regressions**

```bash
npm test
```

Expected: 109+ existing tests + 1 new test all pass. (Existing count was
109 in v0.5.0; the new test brings it to 110.)

- [ ] **Step 6: Commit**

```bash
git add server.js test/server-additions.test.js
git commit -m "$(cat <<'EOF'
feat(server): /api/health gains extensionLastSeenAt heartbeat field

Module-level lastIngestAt mutable, updated on every successful
/api/usage/ingest POST, exposed by /api/health as an ISO 8601 string
(null on cold start). The dashboard's extension-detection logic will
use this as the Layer 1 (heartbeat) signal — graceful-degradation
fallback when the Layer 2 (browser-side window global injected by
extension v0.1.8) is unavailable. In-memory only; resets on restart.
The heartbeat re-fires within ~1 minute when claude.ai is open.
EOF
)"
```

---

## Phase 3: Dashboard banner

### Task 5: Add banner DOM scaffold to `public/index.html`

**Files:**
- Modify: `public/index.html`

The banner sits at the top of `<body>`, above all tab content. It's
display:none by default and only revealed by `app.js` when detection
state is `NOT_DETECTED` and the dismissal window has expired.

- [ ] **Step 1: Read the current top of body**

```bash
grep -n "<body>\|<main>\|class=\"topbar\"" public/index.html | head -5
```

Identify the first element after `<body>` — this is where the banner
inserts.

- [ ] **Step 2: Insert the banner DOM immediately after `<body>` opens**

Find the line in `public/index.html` that contains `<body>` (or the
opening of the first major container). Add the banner element as the
FIRST child of `<body>`:

```html
<aside id="extension-banner" class="ext-banner" role="status" aria-live="polite" hidden>
  <div class="ext-banner-icon" aria-hidden="true">ⓘ</div>
  <div class="ext-banner-text">
    <strong>See your claude.ai plan rings — install Clauge Sync</strong>
    <span class="ext-banner-sub">A 1-click browser extension that syncs claude.ai data to Clauge.</span>
  </div>
  <a class="ext-banner-cta"
     href="https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga"
     target="_blank" rel="noopener noreferrer">Install Clauge Sync</a>
  <button id="extension-banner-dismiss" class="ext-banner-close" type="button" aria-label="Dismiss banner">×</button>
</aside>
```

The `hidden` attribute keeps the banner off-screen until `app.js`
removes it.

- [ ] **Step 3: Verify HTML still parses**

```bash
node -e "
const src = require('fs').readFileSync('public/index.html', 'utf8');
const opens = (src.match(/<aside\b/g) || []).length;
const closes = (src.match(/<\/aside>/g) || []).length;
console.log('aside open/close:', opens, '/', closes);
if (opens !== closes) process.exit(1);
"
```

Expected: matched count of `<aside>` and `</aside>` (both should be at
least 1, and equal). If unequal, the banner block is malformed.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(dashboard): banner DOM scaffold for extension install CTA

Hidden-by-default <aside id=\"extension-banner\"> at the top of body. The
follow-up CSS + JS commits style and conditionally reveal it. Uses
role=status + aria-live=polite so screen readers announce when shown."
```

---

### Task 6: Banner CSS

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: Append banner styles to `public/styles.css`**

Append at the end of the file:

```css
/* v0.5.1: extension install banner (top of dashboard, dismissible). */
.ext-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-info, #0d3a5c);
  border-bottom: 1px solid var(--border-info, #1d5b8c);
  color: var(--fg-info, #d6e9f5);
  font-size: 13px;
  line-height: 1.4;
}
.ext-banner[hidden] { display: none; }

.ext-banner-icon {
  flex: 0 0 auto;
  font-size: 18px;
  opacity: 0.85;
}

.ext-banner-text {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ext-banner-text strong { font-weight: 600; }
.ext-banner-sub { opacity: 0.75; font-size: 12px; }

.ext-banner-cta {
  flex: 0 0 auto;
  padding: 6px 14px;
  background: var(--brand-2, #4a9eff);
  color: white;
  border-radius: 6px;
  text-decoration: none;
  font-weight: 500;
  font-size: 12px;
}
.ext-banner-cta:hover { filter: brightness(1.1); }

.ext-banner-close {
  flex: 0 0 auto;
  background: transparent;
  border: none;
  color: var(--fg-info, #d6e9f5);
  font-size: 20px;
  line-height: 1;
  padding: 4px 8px;
  cursor: pointer;
  opacity: 0.6;
}
.ext-banner-close:hover { opacity: 1; }
```

The CSS uses `var(--…)` for colors with hex fallbacks, so it works in
both Tauri webview (which has the design tokens) and a plain browser
(falls back to the literals).

- [ ] **Step 2: Smoke check the dashboard renders without breaking**

Start the server:

```bash
PORT=3456 node server.js &
sleep 1
curl -s http://127.0.0.1:3456/styles.css | tail -50
kill %1 2>/dev/null || true
```

Expected: the new CSS rules appear at the bottom of the served file.

- [ ] **Step 3: Commit**

```bash
git add public/styles.css
git commit -m "feat(dashboard): styling for extension install banner

Top-of-dashboard banner, full-width, info-blue background, with icon +
two-line text + CTA button + dismiss x. Uses CSS custom properties with
hex fallbacks so it renders correctly in both the Tauri webview and the
plain-browser npx clauge surface."
```

---

### Task 7: Detection logic + banner show/hide + dismissal

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Read the top of `app.js` to find the right insertion point**

```bash
head -50 public/app.js
```

Identify where the dashboard initialization runs. The detection logic
hooks into:
1. The existing `/api/health` fetch (to get `extensionLastSeenAt`)
2. A `DOMContentLoaded` listener (to run initial detection)
3. A periodic poll (to re-detect after dismissal window or extension
   install)

- [ ] **Step 2: Add the detection module at the top of `app.js`**

Insert this block near the top of `public/app.js`, after any existing
imports/constants but before the main initialization. Adjust the exact
location to fit the file's existing structure:

```javascript
// v0.5.1: Clauge Sync extension detection.
// Two-layer signal:
//   Layer 1 (heartbeat) — /api/health.extensionLastSeenAt (set by the
//                         server when the extension's background.js POSTs
//                         a usage ingest; ~1 min cadence)
//   Layer 2 (page marker) — window.__claugeSyncInstalled (set by the
//                           extension's content-dashboard.js, v0.1.8+)
const EXT_DISMISSAL_KEY = 'clauge.extension_dismissed_at';
const EXT_DISMISSAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EXT_HEARTBEAT_FRESHNESS_MS = 10 * 60 * 1000;       // 10 minutes
const EXT_CWS_URL =
  'https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga';

// Module-level cache of the most recent /api/health response's
// extensionLastSeenAt value. Set by the existing health poll.
let __extLastSeenAt = null;

function detectExtensionState() {
  if (typeof window.__claugeSyncInstalled === 'string') {
    return { state: 'INSTALLED_ACTIVE', version: window.__claugeSyncInstalled };
  }
  if (__extLastSeenAt) {
    const age = Date.now() - new Date(__extLastSeenAt).getTime();
    if (age < EXT_HEARTBEAT_FRESHNESS_MS) {
      return { state: 'INSTALLED_INACTIVE', version: 'unknown' };
    }
  }
  return { state: 'NOT_DETECTED' };
}

function isBannerDismissed() {
  try {
    const raw = localStorage.getItem(EXT_DISMISSAL_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return (Date.now() - ts) < EXT_DISMISSAL_WINDOW_MS;
  } catch (e) {
    return false; // localStorage unavailable (incognito, restricted) — show banner.
  }
}

function dismissBanner() {
  try { localStorage.setItem(EXT_DISMISSAL_KEY, String(Date.now())); } catch {}
  const el = document.getElementById('extension-banner');
  if (el) el.hidden = true;
}

function renderExtensionBanner() {
  const el = document.getElementById('extension-banner');
  if (!el) return;
  const detection = detectExtensionState();
  const shouldShow = detection.state === 'NOT_DETECTED' && !isBannerDismissed();
  el.hidden = !shouldShow;
}

// Wire dismissal click once on load.
function initExtensionBannerDismissHandler() {
  const btn = document.getElementById('extension-banner-dismiss');
  if (btn) btn.addEventListener('click', dismissBanner);
}
```

- [ ] **Step 3: Wire the heartbeat field into the existing health poll**

Find the place(s) in `app.js` that fetch `/api/health`. The shape is
typically:

```javascript
const r = await fetch('/api/health');
const h = await r.json();
// ...existing usage of h.version, h.subscriptionCost, etc.
```

Immediately after parsing the health response, capture the new field:

```javascript
__extLastSeenAt = h.extensionLastSeenAt || null;
renderExtensionBanner();
```

If there are multiple health-fetch sites, update each. If unsure, search:

```bash
grep -n "/api/health" public/app.js
```

- [ ] **Step 4: Wire the initial detection on dashboard load**

Find the existing `DOMContentLoaded` (or `window.addEventListener('load', …)`)
block in `app.js`. Add:

```javascript
initExtensionBannerDismissHandler();
renderExtensionBanner();  // First render based on whatever __extLastSeenAt
                          // is at this point (likely null until the first
                          // health fetch completes; banner re-renders then).
```

If `app.js` doesn't have an obvious init function, add one near the
bottom of the file:

```javascript
document.addEventListener('DOMContentLoaded', () => {
  initExtensionBannerDismissHandler();
  renderExtensionBanner();
});
```

If a `DOMContentLoaded` handler already exists, append the two calls
inside the existing handler instead of adding a new listener.

- [ ] **Step 5: Wire window.focus re-detection**

Add at the bottom of `app.js`:

```javascript
window.addEventListener('focus', () => {
  // User may have just installed the extension in a different tab —
  // re-detect to flip the banner off if so.
  renderExtensionBanner();
});
```

- [ ] **Step 6: Manual smoke — three states**

Start the server with no ingest yet, no extension installed:

```bash
PORT=3456 node server.js &
```

In Chrome:
1. **NOT_DETECTED state**: open DevTools → Application → Local Storage,
   delete `clauge.extension_dismissed_at` if present. Open
   `http://localhost:3456`. Banner should appear at top of page. Click
   the dismiss `×`. Banner hides; localStorage gets the timestamp.
   Reload — banner stays hidden (within 7-day window).
2. **INSTALLED_INACTIVE state**: clear the localStorage dismissal again.
   POST a fake ingest from the terminal:
   ```bash
   curl -s -X POST http://127.0.0.1:3456/api/usage/ingest \
     -H 'Content-Type: application/json' \
     -d '{"usage":{"five_hour_limit_pct":0}}'
   ```
   Reload the dashboard. Banner should be hidden (heartbeat was within
   10 min). Wait 10+ min OR restart the server (to reset
   `lastIngestAt`); reload — banner appears again.
3. **INSTALLED_ACTIVE state**: with extension v0.1.8 loaded unpacked
   (Phase 1 outcome), reload the dashboard. The content script sets
   `window.__claugeSyncInstalled`. Banner stays hidden regardless of
   heartbeat.

```bash
kill %1 2>/dev/null || true
```

If any state is wrong, return to Steps 2-5 and fix.

- [ ] **Step 7: Commit**

```bash
git add public/app.js
git commit -m "$(cat <<'EOF'
feat(dashboard): extension detection logic + install banner

Two-layer detection (Layer 2 page marker authoritative; Layer 1 heartbeat
fallback for users still on extension v0.1.7). Banner shows when
NOT_DETECTED state AND not within the 7-day dismissal window; auto-hides
when detection flips positive (re-checked on every health poll AND on
window.focus). Dismissal persists via localStorage clauge.extension_
dismissed_at, scoped to the dashboard origin so it works across both the
Tauri webview and the npx clauge browser surface.
EOF
)"
```

---

## Phase 4: Settings status row

### Task 8: Add status row DOM in claude.ai sync settings card

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Locate the existing claude.ai sync settings card**

```bash
grep -n "claude.ai sync\|set-desc.*Browser extension" public/index.html
```

Find the settings card (around line 406 — the `<h2 style="font-size:14px">claude.ai sync</h2>`).

- [ ] **Step 2: Insert the status row at the top of the card body**

Immediately AFTER the `<h2>claude.ai sync</h2>` line and BEFORE the
existing `<p class="set-desc">...</p>` line, add:

```html
<div id="extension-status-row" class="ext-status-row" data-state="NOT_DETECTED">
  <span class="ext-status-dot" aria-hidden="true">●</span>
  <span class="ext-status-text">Detecting…</span>
  <a class="ext-status-cta"
     href="https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga"
     target="_blank" rel="noopener noreferrer"
     hidden>Install Clauge Sync →</a>
</div>
```

The `data-state` attribute is updated by `app.js` to one of
`INSTALLED_ACTIVE`, `INSTALLED_INACTIVE`, `NOT_DETECTED`. CSS uses
attribute selectors to color the dot. The CTA link is shown only in
`NOT_DETECTED`.

- [ ] **Step 3: Verify HTML structure**

```bash
grep -A 2 'id="extension-status-row"' public/index.html
```

Confirm the block is present and well-formed.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(dashboard): Settings status row DOM for extension state

In Settings → claude.ai sync, a status row at the top of the card with a
colored dot, status text, and a 'Install Clauge Sync' link that's only
visible when the extension is not detected. JS wiring lands in the next
commit; CSS in the one after."
```

---

### Task 9: Status row CSS

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: Append status row styles**

Append to `public/styles.css`:

```css
/* v0.5.1: extension status row in Settings → claude.ai sync card. */
.ext-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  background: var(--bg-subtle, rgba(255,255,255,0.03));
  border-radius: 6px;
  font-size: 12px;
}

.ext-status-dot {
  font-size: 14px;
  line-height: 1;
}

.ext-status-row[data-state="INSTALLED_ACTIVE"] .ext-status-dot { color: #22c55e; }
.ext-status-row[data-state="INSTALLED_INACTIVE"] .ext-status-dot { color: #f59e0b; }
.ext-status-row[data-state="NOT_DETECTED"] .ext-status-dot { color: #ef4444; }

.ext-status-text {
  flex: 1 1 auto;
  color: var(--fg-secondary, rgba(255,255,255,0.75));
}

.ext-status-cta {
  flex: 0 0 auto;
  color: var(--brand-2, #4a9eff);
  text-decoration: none;
  font-size: 12px;
}
.ext-status-cta:hover { text-decoration: underline; }
.ext-status-cta[hidden] { display: none; }
```

- [ ] **Step 2: Commit**

```bash
git add public/styles.css
git commit -m "feat(dashboard): styling for Settings → claude.ai sync status row

Three-state colored dot (green/amber/red) via [data-state=...] selectors,
plus a conditionally-visible 'Install Clauge Sync' link for the
NOT_DETECTED state. Uses CSS custom properties with hex fallbacks for
both Tauri-webview and plain-browser rendering."
```

---

### Task 10: Wire status row updates in `app.js`

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Add a status-row updater function**

Append to the v0.5.1 detection block in `app.js` (the one added in
Task 7):

```javascript
function relativeTime(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function renderExtensionStatusRow() {
  const row = document.getElementById('extension-status-row');
  if (!row) return;
  const dot = row.querySelector('.ext-status-dot');
  const text = row.querySelector('.ext-status-text');
  const cta = row.querySelector('.ext-status-cta');
  const detection = detectExtensionState();

  row.setAttribute('data-state', detection.state);
  cta.hidden = detection.state !== 'NOT_DETECTED';

  if (detection.state === 'INSTALLED_ACTIVE') {
    if (__extLastSeenAt) {
      const age = Date.now() - new Date(__extLastSeenAt).getTime();
      text.textContent = `Clauge Sync v${detection.version} — last sync ${relativeTime(age)}`;
    } else {
      text.textContent = `Clauge Sync v${detection.version} — installed, no sync yet`;
    }
  } else if (detection.state === 'INSTALLED_INACTIVE') {
    text.textContent = 'Clauge Sync detected, but no recent sync. Open claude.ai in this browser to refresh.';
  } else {
    text.textContent = 'Not detected.';
  }
}
```

- [ ] **Step 2: Call the updater alongside the banner updater**

Find every place that calls `renderExtensionBanner()` (added in Task 7)
and add `renderExtensionStatusRow();` right after each:

- After the `__extLastSeenAt = h.extensionLastSeenAt || null;` line in the
  health-fetch handler
- Inside the `DOMContentLoaded` init
- Inside the `window.addEventListener('focus', …)` handler

Concretely, change every:

```javascript
renderExtensionBanner();
```

to:

```javascript
renderExtensionBanner();
renderExtensionStatusRow();
```

- [ ] **Step 3: Manual smoke — verify the three status states**

Start server, open dashboard, navigate to Settings → claude.ai sync card:

1. Without extension: row shows 🔴 "Not detected." with "Install Clauge
   Sync →" link visible.
2. After `curl` POST to `/api/usage/ingest`: row shows 🟡 "Clauge Sync
   detected, but no recent sync..." (Layer 2 not present; Layer 1 fresh).
3. With extension v0.1.8 loaded unpacked: row shows 🟢 "Clauge Sync
   v0.1.8 — last sync Xs ago" (or "installed, no sync yet" if no ingest
   has happened).

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "$(cat <<'EOF'
feat(dashboard): live-updated Settings status row (v0.5.1)

Three states (INSTALLED_ACTIVE / INSTALLED_INACTIVE / NOT_DETECTED) drive
data-state attribute + colored dot + status text + conditional install
CTA. Updates on every dashboard health poll, every window.focus, and on
DOMContentLoaded. Time-ago is naive (recomputed only on render); good
enough for a panel that's only visible while the user is actively
viewing Settings.
EOF
)"
```

---

## Phase 5: Local manual smoke

### Task 11: End-to-end verification of all three states

**Files:** none modified — verification gate.

This task verifies the whole feature works locally before we ship the
extension to CWS. Treat any failure here as a return-to-implementation
signal.

- [ ] **Step 1: Clean slate**

In Chrome DevTools → Application → Local Storage → `localhost:3456`,
delete the `clauge.extension_dismissed_at` key.

In `chrome://extensions`, remove any installed Clauge Sync entry.

- [ ] **Step 2: Verify NOT_DETECTED**

```bash
PORT=3456 node server.js &
sleep 1
```

Open `http://localhost:3456` (in Chrome, fresh tab).
- Banner: 🔴 visible at top of page with "Install Clauge Sync" CTA
- Settings → claude.ai sync card: 🔴 "Not detected" + install link

`window.__claugeSyncInstalled` in console: `undefined`.

- [ ] **Step 3: Verify INSTALLED_INACTIVE**

In a separate terminal:

```bash
curl -s -X POST http://127.0.0.1:3456/api/usage/ingest \
  -H 'Content-Type: application/json' \
  -d '{"usage":{"five_hour_limit_pct":0}}'
```

Wait ~30 seconds for the dashboard's health poll to pick up the new
`extensionLastSeenAt`. Check:
- Banner: hidden (heartbeat fresh)
- Settings card: 🟡 "detected, but no recent sync..."

(If banner is still showing, click the page or briefly switch tabs to
trigger window.focus → re-render.)

- [ ] **Step 4: Verify INSTALLED_ACTIVE**

Restart the server to reset `lastIngestAt`:

```bash
kill %1 2>/dev/null || true
PORT=3456 node server.js &
sleep 1
```

Load extension v0.1.8 from `extension/` folder via `chrome://extensions`
→ Load unpacked.

Reload `http://localhost:3456`.

`window.__claugeSyncInstalled` in console: `'0.1.8'`.

- Banner: hidden (Layer 2 positive)
- Settings card: 🟢 "Clauge Sync v0.1.8 — installed, no sync yet"

POST a fake ingest:

```bash
curl -s -X POST http://127.0.0.1:3456/api/usage/ingest \
  -H 'Content-Type: application/json' \
  -d '{"usage":{"five_hour_limit_pct":0}}'
```

Wait ~30s, refocus the dashboard tab. Settings card now shows 🟢
"Clauge Sync v0.1.8 — last sync Xs ago".

- [ ] **Step 5: Verify dismissal flow**

Remove the unpacked extension. Restart the server. Reload dashboard.

Banner appears (NOT_DETECTED).
Click `×`. Banner hides.

Local Storage now has `clauge.extension_dismissed_at = <timestamp ms>`.

Reload. Banner stays hidden (within 7-day window).

To verify the 7-day re-prompt without time-travel, manually set the
localStorage key to a value older than 7 days and reload:

```javascript
// In DevTools console:
localStorage.setItem('clauge.extension_dismissed_at',
  String(Date.now() - 8 * 24 * 60 * 60 * 1000));
location.reload();
```

Banner should re-appear.

- [ ] **Step 6: Stop the server**

```bash
kill %1 2>/dev/null || true
```

- [ ] **Step 7: No commit** — verification gate.

If anything fails, return to the relevant earlier task and fix. Phase 5
gate is "all three states behave as designed locally."

---

## Phase 6: Chrome Web Store submission (extension v0.1.8)

### Task 12: Build extension v0.1.8 ZIP and submit

**Files:** none modified — packaging + external submission.

⚠ **EXPLICIT USER ACTION** — the developer must perform the CWS submission
manually via the Chrome Web Store Developer Dashboard. The extension can
take 1-3 days to be reviewed and published.

- [ ] **Step 1: Verify the extension manifest is at v0.1.8**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('extension/manifest.json','utf8')).version)"
```

Expected: `0.1.8`.

- [ ] **Step 2: Build the ZIP**

```bash
cd /Users/adnanrashid/Projects/clauge
mkdir -p dist
rm -f dist/clauge-sync-0.1.8.zip
( cd extension && zip -r ../dist/clauge-sync-0.1.8.zip . -x '*.DS_Store' -x '__MACOSX/*' )
ls -lh dist/clauge-sync-0.1.8.zip
```

Expected: ZIP file created, ~15-30 KB. Note the size.

Verify it includes the new content script:

```bash
unzip -l dist/clauge-sync-0.1.8.zip | grep content-dashboard
```

Expected: line showing `content-dashboard.js`.

- [ ] **Step 3: Submit to Chrome Web Store (USER)**

Confirm with the user before proceeding. Tell them:

> "ZIP built at `dist/clauge-sync-0.1.8.zip`. Please:
>
> 1. Go to https://chrome.google.com/webstore/devconsole/
> 2. Find **Clauge Sync** (extension ID: ailfbgegpplecgcadlkplkllobepfcga)
> 3. Click **Package** → **Upload new package**
> 4. Upload `dist/clauge-sync-0.1.8.zip`
> 5. In the listing description, note the change: 'v0.1.8 adds dashboard
>    detection — a tiny content script on http://localhost/* that lets
>    the Clauge dashboard show whether the extension is installed.'
> 6. Submit for review.
>
> Review typically takes 1-3 days. Reply once approved (or if it's
> rejected — we'll need to address feedback before app v0.5.1 ships)."

- [ ] **Step 4: Wait for CWS approval**

Periodically check the CWS dashboard's status. When status transitions
from "Pending review" to "Published," proceed to Phase 7.

In the meantime, Phase 7 (version bump + macOS smoke) can proceed in
parallel — it doesn't depend on extension review status.

- [ ] **Step 5: No commit** — packaging artifact in `dist/` is gitignored
      (or should be; verify with `git status` that `dist/` is not staged).

---

## Phase 7: Version bump + macOS smoke

### Task 13: Bump version 0.5.0 → 0.5.1 across files

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `popover/index.html`
- Modify: `popover/popover.js`
- Modify: `public/index.html`

- [ ] **Step 1: Search for current 0.5.0 references**

```bash
grep -rn '0\.5\.0' --include='*.json' --include='*.toml' --include='*.html' --include='*.js' --include='*.rs' --include='*.md' . \
  | grep -v node_modules \
  | grep -v src-tauri/target \
  | grep -v '\.lock' \
  | grep -v 'dist/' \
  | grep -v 'docs/superpowers/' \
  | grep -v 'docs/screenshots/v0.5.0/'
```

Expected: lists live version strings. Tag history (gh-pages, prior
release notes) and screenshot paths stay; only LIVE version strings get
bumped.

- [ ] **Step 2: Edit each file**

`package.json:3`:
```json
  "version": "0.5.1",
```

`src-tauri/Cargo.toml:3`:
```toml
version = "0.5.1"
```

`src-tauri/tauri.conf.json:3`:
```json
  "version": "0.5.1",
```

`popover/index.html` — locate `<meta name="po-meta" content="v0.5.0" />`
or similar; update to `v0.5.1`. Locate `id="about-version"` element
content; update to `0.5.1`.

`popover/popover.js` — locate `const serverVersion = '0.5.0'` and update
to `'0.5.1'`.

`public/index.html` — search for any hardcoded `0.5.0` (the about-version
field is set dynamically from `health.version`, but check for fallbacks):

```bash
grep -n '0\.5\.0' public/index.html
```

Update any matches.

- [ ] **Step 3: Run all unit tests**

```bash
npm test && cd src-tauri && cargo test --locked
```

Expected: 110 passing JS tests + 24 passing Rust tests.

- [ ] **Step 4: Commit**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json popover/index.html popover/popover.js public/index.html
git commit -m "chore(v3): bump version 0.5.0 -> 0.5.1"
```

---

### Task 14: macOS local smoke

**Files:** none modified — verification gate.

- [ ] **Step 1: Tauri dev mode smoke**

```bash
cd src-tauri && cargo tauri dev
```

Wait ~30-60s for build. Verify:
- Menu-bar icon appears
- Click → popover opens with 3 rings
- Right-click → menu shows Show Dashboard / Settings / Quit
- Show Dashboard → dashboard window opens at 1100×800
- About panel (Settings → General → About) shows version `0.5.1`
- Banner appears at top of dashboard if extension not detected
- Settings → claude.ai sync card shows status row

Stop with Ctrl-C.

- [ ] **Step 2: Tauri release-build smoke**

```bash
cd src-tauri && cargo tauri build --target universal-apple-darwin
```

Wait ~5-15 min. Open the produced .app:

```bash
open src-tauri/target/universal-apple-darwin/release/bundle/macos/Clauge.app
```

Repeat the verification from Step 1 against the production-like build.

- [ ] **Step 3: No commit** — verification gate.

If any regression, return to fix and re-run.

---

## Phase 8: Tag + ship + verify

### Task 15: Tag v0.5.1

**Files:** none modified — release action.

⚠ **EXPLICIT USER APPROVAL GATE** — per `feedback_pr_merge_authorization.md`,
tag pushes are shared-state writes. Before pushing, confirm with the user:

> "Extension v0.1.8 is live in CWS (verify in dashboard). Local smoke
> green. Ready to ship app v0.5.1. Push the tag?"

Do NOT push the tag if the extension is still in CWS review — the
dashboard's Layer 2 detection will fail for users who install via CWS
during the gap. Layer 1 still works, so this is recoverable, but ship
in the right order.

- [ ] **Step 1: Confirm extension v0.1.8 is published in CWS**

Open https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga
in a browser. The version line should read `0.1.8`. If it's still showing
0.1.7, wait — do not proceed.

- [ ] **Step 2: Push commits to main**

```bash
git push origin main
```

- [ ] **Step 3: Create + push the tag**

```bash
git tag v0.5.1
git push origin v0.5.1
```

This triggers the existing release workflow on macOS-only (the v0.6.0
matrix from the Windows port isn't merged yet; the current
release.yml builds macOS only).

- [ ] **Step 4: No commit** — tag is the artifact.

---

### Task 16: Verify CI + auto-update path

**Files:** none modified — verification.

- [ ] **Step 1: Watch the release workflow**

```bash
gh run watch
```

Expected: ~12-15 min on macOS-14 runner. Final state: green.

- [ ] **Step 2: Verify GitHub Release artifacts**

```bash
gh release view v0.5.1
```

Expected assets:
- `Clauge_0.5.1_aarch64.dmg` (or universal)
- `Clauge_0.5.1_x86_64.dmg` (or universal)
- `Clauge.app.tar.gz` + `Clauge.app.tar.gz.sig`
- `latest.json`

- [ ] **Step 3: Verify gh-pages `latest.json`**

```bash
curl -s https://clauding-lab.github.io/clauge/latest.json | jq .
```

Expected: `version: "0.5.1"`.

- [ ] **Step 4: Verify auto-update from v0.5.0**

If you have a v0.5.0 install at `/Applications/Clauge.app`:

1. Right-click the menu-bar icon → Check for Updates
2. Confirm it offers v0.5.1
3. Apply → restart
4. Verify the running app shows version `0.5.1` in the About panel
5. Confirm the dashboard banner appears (or not) according to your
   extension install state — if v0.1.8 of Clauge Sync is installed in
   the same browser profile, banner stays hidden; otherwise it shows

- [ ] **Step 5: No commit** — release shipped.

---

## Self-Review

I checked the plan against the spec.

**1. Spec coverage:**
- ✅ "Adds (extension)": Task 1 (manifest), Task 2 (content-dashboard.js), Task 12 (CWS submission)
- ✅ "Adds (server)": Task 4 (lastIngestAt + extensionLastSeenAt)
- ✅ "Adds (dashboard)": Task 5-7 (banner DOM/CSS/JS), Task 8-10 (Settings status row DOM/CSS/JS)
- ✅ "Modifies (versioning)": Task 13 (bump 0.5.0 → 0.5.1 across all listed files)
- ✅ "Decisions": all 10 decisions reflected in tasks (banner placement, dismissal cadence, localStorage key, no popover prompt, etc.)
- ✅ "Definition of done": each item maps to a Phase 5 or Phase 8 verification step

**2. Placeholder scan:**
- No "TBD," "TODO," "implement later" content
- Code blocks are concrete; commands are exact
- Each task has either a TDD test or a manual verification step

**3. Type/identifier consistency:**
- `__extLastSeenAt` (Task 7) → referenced in `renderExtensionStatusRow` (Task 10) ✅
- `EXT_DISMISSAL_KEY` value `'clauge.extension_dismissed_at'` matches the Phase 5 manual smoke verification step ✅
- `data-state` attribute values (`INSTALLED_ACTIVE` / `INSTALLED_INACTIVE` / `NOT_DETECTED`) match between HTML scaffold (Task 8), CSS selectors (Task 9), and JS updater (Task 10) ✅
- The CWS URL is identical across the banner DOM (Task 5), Settings DOM (Task 8), JS constant (Task 7), and verification step (Task 16) ✅

**4. Known soft spots:**
- Task 7 Step 3 says "find every place that fetches /api/health" — the exact file location isn't pre-identified. Engineer must grep. Acceptable; alternative would be to read the whole `app.js` here and pin a line, but that would bloat the plan with code unrelated to the change.
- Task 12 is a manual user action (CWS submission). Cannot be automated. Plan flags this with the ⚠ marker.
- The 7-day re-prompt cadence is not unit-tested (would require time-mocking infra not currently in the test suite). Manual smoke covers it via the localStorage time-travel trick in Task 11 Step 5.
