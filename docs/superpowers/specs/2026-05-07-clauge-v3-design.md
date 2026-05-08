# Clauge V3 — Native Desktop App (Tauri + Node SEA Sidecar)

**Status:** Draft, pending user review
**Date:** 2026-05-07
**Author:** Adnan + Claude (brainstorming session)
**Predecessor:** V2.2 (browser extension + npm package, shipped 2026-05-07)

---

## 1. Goal

Ship Clauge as a native macOS desktop app that wraps the existing analytics engine in a tray-icon menu bar UI plus a full dashboard window — without rebuilding the dashboard from scratch and without breaking the V2.2 npm and browser-extension distributions.

V3 is **additive**: the npm package and Chrome extension stay alive and supported. V3 is a new install path for users who prefer a native app over a browser tab.

## 2. Non-goals

V3.0 explicitly excludes:

- New dashboard features (per-project drill-down, intelligence banner, sortable session-table headers, one-shot success-rate column) — defer to V3.0.x patches
- Windows or Linux builds — defer until macOS is stable
- Mac App Store distribution — defer until user demand is proven
- Apple Developer Program enrollment ($99/yr) — defer; V3.0 ships unsigned
- Rust rewrite of `lib/*` analytics modules — only if MAS becomes urgent later
- Native push notifications when crossing usage thresholds — V3.x feature
- Global keyboard shortcuts (e.g., `⌘⇧C` to summon popover) — V3.x feature
- `clauge://` deep links — V3.x feature
- Live menu-bar text label (e.g., `$8.42 today` in the menu bar) — V3.x feature

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | All three surfaces coexist (npm + extension + V3) | V3 is additive distribution, not a replacement. Users pick the install path that fits them. |
| 2 | V3 = menu bar popover + native dashboard window | Both surfaces are designed in `docs/design/{menubar,dashboard}.jsx`. Menu bar is primary glanceable UI; window opens on demand. |
| 3 | Bundled Node.js SEA sidecar | Reuses 100% of existing `server.js` + `lib/*` (113 passing tests). Smaller scope than Rust rewrite, faster ship, no maintenance burden of two parser codebases. |
| 4 | Mac-first, ships unsigned | Defers $99/yr Apple Developer Program decision. Users hit Gatekeeper "right-click → Open" warning once on install; auto-update preserves trust thereafter via post-download quarantine strip. |
| 5 | Native shell only, no new dashboard features | Tightest scope, fastest ship (1–2 weeks). Polish items defer to V3.0.x. |
| 6 | Tauri 2.x + Node SEA via `tauri-plugin-shell` | Official Tauri pattern. Node 22 SEA is the official Node-supported single-binary path (replaces deprecated `pkg`). Pure-JS `lib/*` has no native modules — clean SEA fit. |
| 7 | Auto-update via `tauri-plugin-updater` + post-download `xattr -d com.apple.quarantine` | Updates verified by Tauri's own keypair (independent of Apple signing). Quarantine strip prevents Gatekeeper warning on each update. Zero user friction. |
| 8 | Auto-launch at login default ON, toggleable | Per user preference. Toggle exposed via 3-row Preferences view inside popover ⚙ button. |
| 9 | Smart port-sharing model | V3 health-pings 127.0.0.1:3456 on launch. If a clauge server already responds, V3 acts as pure UI client (no second sidecar). Otherwise V3 spawns its own. Health-checks every 30s; respawns if external server dies. |
| 10 | Sidecar crashes recover silently | Tauri auto-respawns. Notification only on 3rd crash within 60s; respawn continues regardless. No tray icon state machine. |

## 4. Architecture

### 4.1 System overview

```
┌─────────────────────────── Tauri app (clauge.app) ──────────────────────────┐
│                                                                              │
│   ┌──────────────────────┐     spawn      ┌──────────────────────────────┐   │
│   │  Tauri main process  │ ─────────────▶ │  clauge-server (Node SEA)    │   │
│   │       (Rust)         │                │                              │   │
│   │                      │ ◀── HTTP ────▶ │  server.js + lib/* + Hono    │   │
│   │  - lifecycle         │                │  binds 127.0.0.1:3456        │   │
│   │  - tray icon         │                │  (fallback 3457..3460)       │   │
│   │  - window manager    │                └──────────────────────────────┘   │
│   │  - native menu       │                              │                    │
│   │  - updater           │                              │ reads/writes       │
│   │  - autostart         │                              ▼                    │
│   │  - notifications     │                ~/.claude/projects/*.jsonl         │
│   │  - sidecar lifecycle │                ~/.clauge/usage.json               │
│   │  - health-check loop │                                                   │
│   └──┬─────────────┬─────┘                                                   │
│      │             │                                                         │
│      ▼             ▼                                                         │
│  ┌─────────┐  ┌─────────────┐                                                │
│  │ Tray    │  │ Dashboard   │                                                │
│  │ popover │  │ window      │                                                │
│  │ 380px   │  │ chrome+nav  │                                                │
│  │menubar  │  │ loads       │                                                │
│  │.html    │  │public/      │                                                │
│  │vibrancy │  │index.html   │                                                │
│  │frameless│  │via http     │                                                │
│  └─────────┘  └─────────────┘                                                │
│       │                  │                                                   │
└───────┼──────────────────┼───────────────────────────────────────────────────┘
        │                  │
        └────── HTTP ──────┴─────▶ 127.0.0.1:<port>/api/*  (same sidecar)

External (unchanged):
  Chrome extension v0.1.7 ──HTTP POST──▶ 127.0.0.1:3456/api/usage/ingest
                                         (only writes to first server on 3456)
```

### 4.2 Tauri features leveraged

**Required plugins:**
- `tauri-plugin-shell` — spawn the SEA sidecar; SIGTERM on quit
- `tauri-plugin-single-instance` — second launch focuses existing instance
- `tauri-plugin-autostart` — Launch at Login (default ON)
- `tauri-plugin-updater` — auto-update via Tauri keypair
- `tauri-plugin-notification` — crash recovery + update-installed toasts
- `tauri-plugin-window-state` — dashboard window remembers size + position
- `tauri-plugin-store` — settings persistence (`autostart` toggle, future polish)

**Native UX features:**
- WKWebView (automatic on macOS) — ~50% less memory than Electron
- Window vibrancy on popover — `decorations: false`, `transparent: true`, `vibrancy: "popover"`
- Pre-rendered popover — window created hidden at boot, shown on tray click (<50ms perceived latency)
- Native macOS menu bar (File / Edit / View / Window / Help)
- Tray right-click native menu (Open Dashboard / Preferences / Check for Updates / Quit)

## 5. Components

| Component | Tech | Responsibility | New code |
|---|---|---|---|
| Tauri Rust main (`src-tauri/src/main.rs`) | Rust | Single-instance guard, sidecar lifecycle, tray icon + menu, window manager, native macOS menu, updater, autostart, notifications, sidecar health-check loop, IPC commands | New, ~150 LOC |
| `clauge-server` SEA binary | Node SEA (Node 22+) | Hono HTTP server, all existing `/api/*` endpoints unchanged; adds `GET /api/health`, port fallback (3456 → 3460), graceful SIGTERM with pending-write flush | Reuses `server.js` + `lib/*`. ~25 LOC added in `server.js` (health endpoint + listen-retry loop + SIGTERM handler). |
| Tray UI | Tauri-native (Rust, not HTML) | 16×16 + 32×32 monochrome template-image icon. Left-click toggles popover. Right-click native menu. | Rust config |
| Popover window | Tauri WebView | Frameless, 380px × dynamic height, vibrancy popover, pre-rendered. Two views (Main / Preferences) with slide animation. | New: `popover/{index.html, popover.js, popover.css}`, ~400 LOC |
| Dashboard window | Tauri WebView | Loads `http://127.0.0.1:<port>/`, decorated chrome, native menu, lazy-created, hidden on close, state persisted | Zero — `public/` unchanged |
| Build pipeline | Shell + GitHub Actions | `scripts/build-sidecar.sh` builds Universal SEA binary (arm64 + x86_64 → `lipo`). `tauri build` produces `.app` + `.dmg`. CI signs update payload, publishes to GitHub Releases. | New, ~50-line shell + ~80-line workflow YAML |
| Test surface | `node:test`, `cargo test`, `tauri-driver` | Existing 113 JS unit tests unchanged. New: SEA smoke (~5), Rust unit (~6–8), Tauri-driver E2E (~7), manual release checklist | New tests, ~200 LOC |

### 5.1 Implementation specifics

- **Popover-to-server transport:** plain `fetch()` to `http://127.0.0.1:<port>/api/*`, identical pattern to `public/app.js`. Tauri exposes a single IPC command, `get_server_port()`, called once at popover load. No data IPC layer.
- **Universal binary:** built via `lipo` from arm64 + x86_64 SEA outputs. One DMG works on Apple Silicon and Intel Macs.
- **Dashboard window URL:** uses HTTP (`http://127.0.0.1:<port>/index.html`), not Tauri's `tauri://localhost` asset protocol. `public/app.js` runs unchanged. Trade-off: small HTTP overhead vs zero refactor risk.
- **Settings storage:** `tauri-plugin-store` writes `~/Library/Application Support/com.clauding.clauge/settings.json`.

### 5.2 Repository layout (additions)

```
~/Projects/clauge/
├── src-tauri/                        ← NEW
│   ├── src/main.rs                   ← Tauri Rust entry
│   ├── tauri.conf.json               ← Tauri config (windows, plugins, updater key)
│   ├── icons/                        ← App icon set (16/32/128/256/512/1024)
│   └── capabilities/                 ← Tauri permission scopes
├── popover/                          ← NEW
│   ├── index.html                    ← Frame for vibrancy popover
│   ├── popover.js                    ← Vanilla JS port of menubar.jsx
│   └── popover.css                   ← Reuses public/styles.css tokens
├── scripts/
│   ├── build-sidecar.sh              ← NEW (Node SEA Universal build)
│   └── sea-config.json               ← NEW (SEA blob config)
├── .github/workflows/
│   └── release.yml                   ← NEW (build + sign + publish DMG on tag)
├── lib/                              ← UNCHANGED
├── public/                           ← UNCHANGED
├── server.js                         ← +~25 LOC (/api/health + port fallback + SIGTERM)
├── test/                             ← + sea-smoke + tauri-driver tests
├── package.json                      ← + dev scripts: build:sidecar, build:app
└── docs/superpowers/specs/2026-05-07-clauge-v3-design.md  ← this doc
```

## 6. Data flow

### 6.1 Cold start

```
App launch
  │
  ├─→ [Tauri main] tauri-plugin-single-instance check (focus existing if duplicate)
  │
  ├─→ [Tauri main] HTTP GET 127.0.0.1:3456/api/health (1s timeout)
  │     │
  │     ├─→ "service: clauge" → use existing port; skip sidecar spawn
  │     └─→ no response or non-clauge → spawn ./clauge-server sidecar
  │                                       sidecar tries 3456 → 3457 → ... → 3460
  │                                       writes "CLAUGE_BOUND_PORT=<N>" to stderr
  │                                       Tauri parses stderr, stores port
  │
  ├─→ [Tauri main] create popover window (HIDDEN, vibrancy, frameless, 380px)
  │     │
  │     └─→ popover.js loads → invoke('get_server_port')
  │                          → fetch /api/summary?period=7d
  │                          → fetch /api/usage  (claude.ai plan + balance)
  │
  ├─→ [Tauri main] create tray icon + native menu
  │
  └─→ Done. Dashboard window NOT created until user clicks "Open dashboard →"

Cold-start budget: ~400ms typical / ~1.4s worst-case (stuck non-clauge server on 3456)
  - Tauri Rust startup: ~80ms
  - Health check: ~10ms hit (clauge already on 3456) / <50ms miss (immediate connect-refused, no server) / 1s ceiling (3456 occupied by unresponsive non-clauge server — `tokio::time::timeout(Duration::from_secs(1), …)`)
  - Sidecar spawn: ~120ms (SEA binary)
  - Sidecar bind: ~30ms
  - Popover prerender: ~150ms (parallel with sidecar warm-up)
```

### 6.2 Tray click → popover shown

Pre-rendered popover means click-to-visible is GPU-bound, not network-bound. Perceived latency <50ms.

### 6.3 Extension push (live plan-usage update)

```
Chrome extension service worker (every 60s)
  │
  ├─→ fetches claude.ai/api/organizations,
  │           /api/organizations/{uuid}/usage,
  │           /api/organizations/{uuid}/prepaid/credits,
  │           /api/console/organizations/{platform-uuid}/credits
  │
  └─→ POST http://127.0.0.1:3456/api/usage/ingest
        │
        └─→ whichever clauge server owns 3456 (V3 OR npm clauge)
              ├─→ lib/usage-store.js normalizes payload
              └─→ atomic write ~/.clauge/usage.json

Popover refresh loop (every 10s while visible):
  └─→ GET /api/usage → re-render gauges + balance cards
```

When V3 is on a fallback port (e.g., 3457) because npm clauge owns 3456, `~/.clauge/usage.json` is the cross-server bridge. V3 reads from disk on next poll. ~10s worst-case staleness.

### 6.4 JSONL change detection

```
Claude Code appends to ~/.claude/projects/<dir>/<session>.jsonl during a session
  │
Popover or Dashboard makes /api/summary request
  │
  └─→ [sidecar] lib/session-store.js
        ├─→ readdir ~/.claude/projects/  (~10ms)
        ├─→ stat each file for mtime
        ├─→ reparse only files where mtime > cached mtime
        ├─→ combine cached parses + fresh parses
        └─→ aggregator runs over combined set
```

No file watcher. Poll-on-request is fast enough — V1's existing mtime-keyed cache handles 700+ sessions in ~50ms warm.

### 6.5 Auto-update flow

```
[Tauri main] tauri-plugin-updater scheduled check (1×/day, also on app launch)
  │
  └─→ GET https://clauding-lab.github.io/clauge/latest.json
        │
        └─→ JSON: { version, signature, url }
              │
              ├─→ if version > current: download .tar.gz from url (~25MB)
              ├─→ verify signature against bundled Tauri public key
              ├─→ extract to temp dir
              ├─→ post-extract hook: xattr -d com.apple.quarantine clauge.app
              ├─→ atomic rename: temp clauge.app → /Applications/clauge.app
              └─→ macOS notification: "Clauge updated to v0.3.x"
                  (binary swap is applied; user keeps using current process until they quit;
                   next launch runs the new version)
```

`latest.json` is published to the `gh-pages` branch on each tagged release; updater always has a stable URL. Tauri's signature check uses a keypair generated once via `tauri signer generate`; the public key is embedded in the `.app`, the private key lives in GitHub Actions secrets.

### 6.6 Settings change (autostart toggle)

```
User opens popover → clicks ⚙ → toggles "Launch at login" OFF
  │
  └─→ popover.js: invoke('set_autostart', { enabled: false })
        │
        └─→ [Tauri main] tauri-plugin-autostart.disable()
              ├─→ removes Clauge.app from macOS Login Items
              └─→ tauri-plugin-store writes settings.json: { autostart: false }
```

### 6.7 Quit flow

```
User: ⌘Q  OR  Tray → Quit  OR  red close button on dashboard
  │
  ├─→ [Tauri main] save window state via tauri-plugin-window-state
  ├─→ [Tauri main] SIGTERM clauge-server sidecar
  │     └─→ sidecar flushes pending ~/.clauge writes → exit(0)
  ├─→ [Tauri main] wait up to 2.5s; if sidecar alive, SIGKILL
  └─→ [Tauri main] exit
```

If V3 was running as client (sidecar owned by external clauge), no SIGTERM is sent.

**Sidecar-side details (material to the 2.5s grace window):**

- The SIGTERM handler calls `server.close()` to stop accepting new connections, then `server.closeAllConnections()` to destroy idle HTTP keep-alive sockets. Without `closeAllConnections()`, `@hono/node-server`'s default keep-alive drain holds the server open for ~5s — longer than the Tauri parent's 2.5s grace window, which would force every quit through SIGKILL even on a healthy sidecar.
- Signal handlers (SIGINT, SIGTERM) are installed **before** the `Listening on …` and `CLAUGE_BOUND_PORT=…` log emissions. The Tauri parent reads the port marker as soon as it appears on stderr, so a SIGTERM can race the handler-install on cold start; installing handlers first makes that race graceful instead of a default-action terminate-by-signal (which would skip the pending-write flush).

## 7. Error handling

**Principle:** silent recovery > toast notification > user action prompt.

### 7.1 Severity tiers

- **SILENT** — log to file, retry/recover, user sees nothing
- **TOAST** — single macOS notification, no required action
- **BLOCK** — user must act; show prominent UI prompt

### 7.2 Failure matrix

| Domain | Failure | Severity | Behavior |
|---|---|---|---|
| Sidecar | Binary missing or not executable on launch | BLOCK | Modal: "Clauge is broken — please reinstall." Log to `main.log`. |
| Sidecar | Crash 1st time within 60s | SILENT | Tauri respawns within ~1s. UI's 10s poll loop refreshes data. |
| Sidecar | Crash 2nd time within 60s | SILENT | Same: respawn. |
| Sidecar | Crash 3rd+ time within 60s | TOAST | One notification: "Clauge had a problem — please restart the app." Tauri respawns anyway. |
| Sidecar | All ports 3456–3460 busy | TOAST | "Clauge couldn't find a free port. Quit other apps using ports 3456–3460 and relaunch." Sidecar retries port-bind every 30s. UI shows "Server not running." |
| HTTP | Connection refused from popover/dashboard | SILENT | Loading state persists; next 10s poll retries. Tauri's 30s health-check detects dead sidecar and respawns. |
| HTTP | Slow response (>5s) | SILENT | Spinner stays. Most slow responses are first-time JSONL parses warming the cache. |
| HTTP | 5xx from sidecar | SILENT | Log to console; retry on next poll. |
| FS | `~/.claude/projects/` doesn't exist | SILENT | Sidecar returns empty data. UI: "No Claude Code sessions found yet." |
| FS | `~/.clauge/` doesn't exist | SILENT | Sidecar creates it on first write (mode 0700). UI: "Install Clauge Sync extension." |
| FS | JSONL malformed line | SILENT | Parser skips line, logs to `server.log`, continues. (Existing V1 behavior.) |
| FS | `~/.clauge/usage.json` write fails | SILENT | Log to `server.log`. Extension POST returns 200 anyway. |
| Update | GitHub unreachable | SILENT | Updater fails check; no notification. Retries next day. Manual "Check for Updates" surfaces error if user clicks. |
| Update | Signature verification fails | SILENT then TOAST | Log to `main.log` with payload hash. Don't apply. Retry next day. After 3 failures: TOAST "Update verification failed. Open GitHub Releases manually." |
| Update | `xattr -d` post-download fails | TOAST | "Update installed but Gatekeeper warning will reappear. Right-click Clauge.app → Open after launch." |
| Update | Disk full during update | TOAST | "Update couldn't install — free up disk space and try again." Old version stays running. |
| Tauri | Tray icon fails to register | BLOCK | Modal: "Clauge couldn't add itself to the menu bar. Please report this with your macOS version." |
| Tauri | Window creation fails | TOAST | Log + notification. App stays running with whatever UI did create. |
| Tauri | macOS notification permission denied | SILENT | Crash-recovery notifications are skipped. Don't repeatedly ask. |
| Tauri | Autostart toggle fails | TOAST | "Couldn't update Launch at Login. Open System Settings → General → Login Items to set manually." Toggle reverts to actual state. |
| Tauri | `tauri-plugin-store` settings file corrupt | SILENT | Reset to defaults. Log corruption. |

### 7.3 Logging

All logs in **`~/Library/Logs/clauge/`**:

- `main.log` — Tauri Rust events (lifecycle, IPC, updater, errors)
- `server.log` — sidecar stdout/stderr piped by Tauri

Rotation: 5 files × 1 MB each. Oldest dropped.

Popover Preferences includes a "View Logs" button that opens the folder in Finder.

### 7.4 Crash-loop circuit-breaker

```
ON sidecar exit (non-zero):
  push now() to crashes[]
  drop entries older than 60s
  IF len(crashes) == 1:  silent respawn
  IF len(crashes) == 2:  silent respawn
  IF len(crashes) == 3:  send macOS notification, respawn anyway
  IF len(crashes) >= 4:  respawn with exponential backoff (2s, 4s, 8s capped) starting from the 4th crash within the window
```

Respawn-anyway-on-3 is deliberate: the user keeps a working UI; they choose when to restart.

### 7.5 Explicitly NOT handled

- Recovery from corrupted `~/.claude/projects/` files (Claude Code's data, not ours)
- LiteLLM fetch failures (already handled by bundled `lib/litellm-prices.fallback.json`)
- External monitor / multi-display popover positioning (Tauri handles natively)

## 8. Testing strategy

### 8.1 Test pyramid

```
          ╲    Manual release checklist (~10min, pre-tag)
         ╱╲
        ╱  ╲   Tauri-driver E2E (~5min, runs on tag/nightly)
       ╱────╲
      ╱      ╲ Rust unit + SEA smoke (~30s + ~10s)
     ╱        ╲
    ╱──────────╲
   ╱  Existing  ╲ 113 JS unit tests (~3s) — unchanged
  ╱  unit tests  ╲
 ╱────────────────╲
```

### 8.2 Layer 1 — Existing JS unit tests

`node --test test/*.test.js` runs as today. Covers parser, classifier, cost, cache, ROI, exporter, period, usage-store, bookmarklet. 113 tests, ~3s. **No changes needed.**

### 8.3 Layer 2 — SEA smoke (new)

`test/sea-smoke.test.js`, ~50 LOC. After `scripts/build-sidecar.sh`:

1. Spawn `./dist/clauge-server` as subprocess
2. Wait for both startup markers in parallel: `Listening on …` on stdout AND `CLAUGE_BOUND_PORT=<N>` on stderr (both must arrive before progressing — they're emitted on independent streams)
3. `curl http://127.0.0.1:<N>/api/health` → expect 200, `{ service: "clauge" }`
4. `curl /api/sessions?period=7d` → expect 200, valid JSON
5. `process.kill('SIGTERM')`
6. Assert clean exit within 2.5s (matches the §6.7 grace-window cushion for `closeAllConnections`)

Catches: bad SEA blob config, missing deps, broken port-fallback, hanging shutdown.

Set `SKIP_SEA_SMOKE=1` to skip this layer (e.g. on fresh checkouts where the ~30s SEA build is unwanted).

### 8.4 Layer 3 — Rust unit tests (new)

`src-tauri/src/` test modules, run via `cargo test`. Target ~80% line coverage on Rust code.

| Test | Covers |
|---|---|
| `port_discovery::tests::probe_returns_false_when_no_server` | Nothing listening on 3456 → probe returns false → discover() returns `SpawnAt(3456)` |
| `port_discovery::tests::probe_returns_true_for_clauge_response` | Mock `/api/health` returns `{ service: "clauge" }` → probe returns true → V3 must NOT spawn sidecar (uses `Share`) |
| `port_discovery::tests::probe_returns_false_for_non_clauge_service` | Mock `/api/health` returns a non-clauge body → probe returns false → discover() still returns `SpawnAt(3456)`. Note: Rust always emits `SpawnAt(3456)` regardless; if 3456 is occupied by a non-clauge server, the Node sidecar's own port-fallback (3456→3460 via `listenWithRetry`, T6) handles it and reports the bound port via stderr `CLAUGE_BOUND_PORT=<n>` (consumed in T11). |
| `sidecar::tests::first_crash_is_silent` | 1st crash within window → silent respawn |
| `sidecar::tests::second_crash_within_60s_is_silent` | 2nd crash within 60s → silent respawn |
| `sidecar::tests::third_crash_within_60s_notifies` | 3rd crash within 60s → one-shot macOS notification, respawn anyway |
| `sidecar::tests::fourth_crash_within_60s_backs_off` | 4th crash → exponential backoff (2s) |
| `sidecar::tests::fifth_crash_uses_4s_backoff` | 5th crash → 4s backoff |
| `sidecar::tests::sixth_crash_caps_backoff_at_8s` | 6th+ crash → capped at 8s backoff (verifies `(n-3).min(3)` math) |
| `sidecar::tests::crashes_outside_window_are_dropped` | Crash, wait >60s, crash again → counts as first crash |
| `sidecar::tests::notification_does_not_repeat_within_same_window` | Once a window has notified, further crashes within it back off without re-notifying |
| `sidecar::tests::notification_fires_again_in_new_window` | Notify in window 1 → window empties → 3 crashes in window 2 → notification fires again |
| `sidecar::tests::crash_at_exact_60s_boundary_keeps_prior_entry` | Window pruning is closed-closed: a crash exactly at the 60s boundary retains the prior entry (strict `>` check) |
| `ipc::get_server_port_returns_active_port` | IPC returns the port the sidecar bound |

### 8.5 Layer 4 — Tauri-driver E2E (new, tag/nightly only)

`test/e2e/v3.test.ts`, uses `tauri-driver` (webdriver). macOS-only. ~5min total.

| Scenario | Assertions |
|---|---|
| App launches → tray icon present | Tray icon registered within 3s |
| Tray click → popover visible | Popover shown within 1s of click |
| Popover loads data | First `/api/summary` resolves; numeric `$X.XX` text visible |
| "Open dashboard →" → window opens | Dashboard window created, V2.2 dashboard rendered |
| ⌘Q → clean exit | App exits within 3s; sidecar process not orphaned |
| Re-launch → window state restored | Dashboard at same size/position as before quit |
| Settings → toggle autostart OFF | macOS Login Items entry removed |

### 8.6 Layer 5 — Manual release checklist

`docs/RELEASE_CHECKLIST.md`. ~10min pre-tag eyeball:

```
□ Install fresh DMG on a Mac that doesn't have V3
□ Right-click → Open passes Gatekeeper warning
□ Tray icon appears within 2s
□ Click tray → popover opens with real data
□ Click "Open dashboard →" → V2.2 dashboard renders
□ Settings → toggle autostart, quit, reboot, app auto-launches
□ Force update check → new version downloads, swaps, restarts
□ Quit app → ps -ef | grep clauge-server returns nothing
□ Coexistence: launch npm clauge first, then V3 → V3 connects as client
□ Coexistence: quit npm clauge while V3 open → V3 spawns own sidecar within 30s
```

### 8.7 CI matrix

**On every PR push** (~1 minute):
- `node --test test/*.test.js`
- `node --test test/sea-smoke.test.js` (single arch on the runner)
- `cargo test --manifest-path src-tauri/Cargo.toml`
- `cargo clippy -- -D warnings`
- `eslint . && stylelint public/**/*.css popover/**/*.css`

**On tag push** (~10 minutes):
- All of the above
- Universal SEA build (arm64 + x86_64 → `lipo`)
- `tauri build` → `.app` → `.dmg`
- Sign update payload with Tauri private key (GitHub secret)
- Tauri-driver E2E suite on `macos-latest`
- Publish `.dmg` + `latest.json` + signature to GitHub Release
- Update `gh-pages` `latest.json` so updater finds it

**Nightly cron:** the tag pipeline against `main`, but skip publishing.

### 8.8 Coverage policy

| Surface | Target | Notes |
|---|---|---|
| Existing `lib/*` | Maintain current coverage | 113 tests, no regressions |
| New Rust (`src-tauri/`) | ~80% line coverage | IPC plumbing covered; plugin glue not |
| Popover JS (~400 LOC) | E2E-covered, no unit-test target | DOM manipulation; mocking the DOM for a 380px popover is low value |
| `scripts/build-sidecar.sh` | SEA smoke covers it | Build broken → smoke fails |

### 8.9 Explicitly NOT tested

- Real claude.ai network calls (extension is unchanged; its tests already exist)
- Mac App Store submission flow (not in scope)
- Windows / Linux behavior (not in V3.0 scope)
- Auto-update against actual GitHub network in CI (signature path tested with fixture; full flow tested manually pre-release)

## 9. Build & distribution

### 9.1 Build pipeline

`scripts/build-sidecar.sh`:

```bash
# 1. Build SEA blob from server.js + lib/* + bundled deps
node --experimental-sea-config scripts/sea-config.json

# 2. Copy node binary, inject SEA blob, code-sign (ad-hoc), strip signature
cp $(command -v node) dist/clauge-server-arm64
codesign --remove-signature dist/clauge-server-arm64
npx postject dist/clauge-server-arm64 NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA

# 3. Repeat for x86_64 (cross-arch via prebuilt node-x64 binary)
# ...

# 4. lipo into Universal binary
lipo -create dist/clauge-server-arm64 dist/clauge-server-x86_64 \
     -output dist/clauge-server
chmod +x dist/clauge-server
```

`scripts/sea-config.json`:

```json
{
  "main": "server.js",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
```

### 9.2 Tauri configuration

`src-tauri/tauri.conf.json` highlights:

- `productName: "Clauge"`
- `identifier: "com.clauding.clauge"`
- Windows: popover (frameless, transparent, 380×600 resizable=false), dashboard (decorated, 1480×1100 default)
- Bundle target: `dmg` for macOS
- `bundle.macOS.minimumSystemVersion: "12.0"` (macOS Monterey+)
- External binaries: `clauge-server` (Universal)
- Updater: pubkey embedded, endpoint `https://clauding-lab.github.io/clauge/latest.json`

### 9.3 GitHub Actions workflow

`.github/workflows/release.yml` triggered on `v*` tag push:

1. Checkout
2. Set up Node 22, Rust stable
3. `npm ci`
4. `node --test test/*.test.js && cargo test`
5. `bash scripts/build-sidecar.sh` (Universal SEA)
6. `npm run tauri build`
7. Sign update payload: `npm run tauri signer sign --private-key $TAURI_PRIVATE_KEY ...`
8. Upload `.dmg` to GitHub Release
9. Update `gh-pages` `latest.json` with new version + signature + URL

Secrets needed:
- `TAURI_PRIVATE_KEY` (generated once via `tauri signer generate`)
- `TAURI_KEY_PASSWORD`

### 9.4 First-install user flow

1. User downloads `Clauge-0.3.0-universal.dmg` from GitHub Releases
2. Opens DMG, drags `Clauge.app` to Applications
3. Double-clicks → Gatekeeper warning ("unidentified developer")
4. Right-click → Open → confirm in dialog
5. App launches; tray icon appears within 2s
6. From here on, auto-update preserves trust via post-download `xattr -d com.apple.quarantine`. No more Gatekeeper prompts.

## 10. Open items deferred to V3.0.x

- Apple Developer Program enrollment ($99/yr) — switches to fully signed + notarized DMG; eliminates Gatekeeper warning on first install
- Mac App Store submission (requires sandbox entitlements + security-scoped bookmarks for `~/.claude/projects` access)
- Windows MSI build + cert ($200/yr)
- Per-project drill-down view
- Intelligence banner (claude.ai pace projections)
- One-shot success-rate column
- Sortable session-table headers
- Auto-reload settings UI testing with a real auto-reload-enabled account
- GitHub social-preview image upload (manual via repo Settings → General → Social preview)
- Theme/appearance preferences
- Configurable port + poll intervals
- Global keyboard shortcuts
- `clauge://` deep links
- Live menu-bar text label (`$8.42 today` directly in the menu bar)
- Native push notifications when crossing usage thresholds

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Node SEA on Node 22 hits a Hono/fetch quirk under build | High — V3 can't ship | Fallback to "raw Node binary + directory" packaging. Larger bundle (~120MB) but well-trodden. Documented in build-sidecar.sh as a fallback target. |
| `xattr -d com.apple.quarantine` is removed from macOS in a future version | High — auto-update Gatekeeper warnings reappear | Fall back to manual download + drag-to-Applications. Apple has not signaled deprecation of `xattr`; risk is speculative. |
| Tauri 2.x breaking changes during V3.0 development | Medium — refactor cost | Pin to a specific Tauri patch version in Cargo.toml. Upgrade in V3.0.x patches with intentional review. |
| User reports popover positioning bug on multi-display setup | Low — niche edge case | Tauri handles natively; debug case-by-case if reported. |
| Sidecar SIGTERM shutdown leaks ~/.clauge writes if Hono buffer not flushed | Medium — corrupt usage.json | Add `process.on('SIGTERM', ...)` handler in `server.js` that awaits pending writes before exit. Test in SEA smoke. |
| Tauri's private signing key compromise | High — attacker can push malicious updates | Key lives only in GitHub Actions secrets. Key-rotation procedure documented in `docs/RELEASE_CHECKLIST.md`: generate new pair via `tauri signer generate`, ship a forced point-release with the new pubkey embedded, rotate GitHub secret. Old version users must reinstall manually since they trust the old key only. |
| Crash-loop circuit-breaker masks a real bug user should know about | Medium — silent failures | Always log full crash stack to `main.log`. "View Logs" button in Preferences. |

## 12. Success criteria

V3.0 is shipped when:

- [ ] `Clauge-0.3.0-universal.dmg` is published to GitHub Releases
- [ ] All 113 existing JS unit tests pass
- [ ] SEA smoke test passes
- [ ] All 6+ Rust unit tests pass
- [ ] All 7 Tauri-driver E2E scenarios pass on `macos-latest`
- [ ] Manual release checklist passes on a fresh Mac
- [ ] Auto-update flow verified: install v0.2.x → update to v0.3.0 → no Gatekeeper warning
- [ ] `Clauge.app` runs on Apple Silicon (M-series) and Intel Macs without separate builds
- [ ] Coexists cleanly with running npm clauge instance (V3 acts as client when external server present)
- [ ] Cold-start to popover-shown is <1s on M-series Macs

## 13. Appendix: implementation phasing hint

Not part of the spec, but a suggestion for the implementation plan that follows:

- **Phase 1** — Tauri shell + sidecar packaging (Rust main, SEA build, basic tray, hello-world popover, dashboard window pointing at existing `public/`). Verifies the whole pipeline end-to-end.
- **Phase 2** — Popover UI (port `menubar.jsx` to vanilla HTML/CSS/JS in `popover/`, wire to live data).
- **Phase 3** — Auto-update + autostart (`tauri-plugin-updater` + `tauri-plugin-autostart` + Preferences view).
- **Phase 4** — Polish & error handling (crash circuit-breaker, log rotation, all toast/block paths from §7.2).
- **Phase 5** — Test + CI + release pipeline.

The implementation plan (next step via `writing-plans` skill) will refine and sequence these.
