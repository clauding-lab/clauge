# Changelog

## 0.4.0 (2026-05-08) — V3: Liquid Glass redesign + popover bug fix

**Major redesign: new popover, full dashboard overhaul, canonical tray
icon. Plus the bulletproof fix for the popover-empty bug that survived
v0.3.1's CORS fix.**

### Popover (300px, warm-dark glass)
- New 5-section layout: Header / Plan capacity (5 mini rings:
  Session/Weekly/Sonnet/Opus/Design) / Finance (Extra usage + Balance cards
  with bars) / Today (Cost eq · Messages · Cache hit) / Footer
  (kbd hints + "Open →").
- Warning-state variant (CSS-only, amber): single big ring + suggestion to drop to haiku. Triggers when `plan.fiveHour.pct >= 85`.
- Visual: warm-dark gradient (`#2a1812 → #0d0805`), brand orange `#d97757`, translucent glass with `backdrop-blur(60px) saturate(180%)`, dual rim-light borders, gradient bleed on the header. Inter UI + JetBrains Mono numerics with `tnum`.

### Dashboard (7-tab Liquid Glass)
- Tabs: Overview · Sessions (count) · Projects (count) · Tools · Models · Settings · About. Morphing brand-orange capsule indicator on tabs + period (`cubic-bezier(.2,.8,.2,1)`).
- Period selector: Today / 7 days / 30 days / Month / All time.
- Overview: Plan capacity hero (5 big rings — Session/Weekly/Sonnet/Opus/Design — + Extra usage + claude.ai balance side cards) → code analytics digest strip (API equivalent, Messages, Sessions, Cache hit, Tokens, Return on sub) → Cost over time + Peak hours charts → By project + By activity tables → Recent sessions teaser.
- Settings tab: General / Pricing & ROI / claude.ai sync sub-panes (read-only mirror of `/api/health` + `/api/usage` for v0.4.0; editable settings deferred and visibly disabled with `aria-readonly`).
- About tab: What it does / Roadmap / Credits.

### Bug fix: popover-empty (T35)
- v0.3.1 fixed CORS at the wire level (response includes `access-control-allow-origin: *`), but the popover STILL rendered empty. Root cause: WKWebView's mixed-content guard. Tauri 2.x's asset protocol routes the popover through `tauri://localhost` (or `https://tauri.localhost`) which WKWebView treats as a Mixed-Content secure context — cross-origin `fetch('http://127.0.0.1:port/api/...')` from such a context is silently dropped before the request leaves the webview.
- Fix: new `proxy_fetch` IPC command that runs the request through Rust's `reqwest` (no fetch layer, no CORS, no mixed-content). Popover JS now calls `invoke('proxy_fetch', { path })` instead of native `fetch()`. Path validation restricts to `/api/*`. Response body is capped at 10 MiB as defense-in-depth.
- Also enabled `tauri = { features = [..., "devtools"] }` so right-click → Inspect Element works in production v0.4.0+. Useful for in-the-field diagnostics; benign for users (no automatic JS exposure of secrets).

### Tray icon (T38)
- Replaced the Pillow-rendered programmatic gauge with a render derived from the canonical `public/clauge-menubar-18px.svg` brand mark. New pipeline (`scripts/render-tray-icon.sh`): flattens SVG colors to black via `sed` (preserve opacities for macOS template tinting), then `sips` renders to 22×22 + 44×44.

### Review fixup (T39, pre-tag)
- **Opus capacity ring restored** — design's 4-ring layout extended to 5 in
  both the popover and dashboard plan-hero so v0.3.x's Session/Weekly/
  Sonnet/Opus/Design parity is preserved for Opus-heavy users.
- **Settings panel honesty** — the General tab's "Show menu bar app"
  toggle and "Default period" select were silent no-ops; they're now
  visibly disabled with `aria-readonly="true"` and a clear "editable
  in v0.4.x" tooltip.
- **Popover OS window dimensions** — inner `300×540` was masking the
  warning-state's CSS-driven 240px width and creating a transparent
  dead zone below content. Tightened to `300×440` and removed the
  warn-state CSS `width: 240px` rule so the OS window matches the
  drawn surface in both states.
- **Self-hosted fonts** — removed `fonts.googleapis.com` and
  `fonts.gstatic.com` references. Inter (variable, latin) and
  JetBrains Mono (variable, latin) now ship as woff2 under
  `popover/fonts/` and `public/fonts/`. Privacy-preserving (no CDN
  beacon), offline-safe, and no cold-start render block.
- **render-tray-icon.sh mktemp leak** — the previous template
  (`mktemp -t clauge-tray-mono).svg`) created a tempfile then a
  separate `.svg` sibling, leaking the original. Now uses
  `mktemp -t clauge-tray-mono.XXXXXX.svg`.
- **Stripped `console.log`** — DevTools now ships in production, so
  diagnostic logs were getting noisy. `console.error` retained for
  in-the-field debugging.

### Tests
- Cargo: 24 (was 22 — added two `proxy_fetch` tests: body-size cap and `PROXY_FETCH_MAX_BYTES` constant pin).
- Node: 109 unchanged.

## 0.2.0 (2026-05-06) — V2: claude.ai integration

**Major addition: claude.ai plan usage tracking via browser extension or bookmarklet.**

### claude.ai integration
- **Clauge Sync** browser extension (Manifest V3) submitted to Chrome Web Store. Polls `claude.ai/api/organizations/{uuid}/usage` every minute (configurable) using the user's authenticated browser cookies, POSTs snapshot to local Clauge.
- **One-click bookmarklet** as a no-extension fallback (drag to bookmarks bar, click while on claude.ai).
- New dashboard card with **5 ring gauges** — Session (5h), All models (7d), Sonnet (7d), Opus (7d), Claude Design — colour-coded by 60/85% thresholds, with reset countdowns.
- **Extra-usage card** showing your billing cap with progress bar.
- Backend endpoints: `POST /api/usage/ingest` (CORS-restricted to claude.ai + extension origins), `GET /api/usage`, `GET /api/bookmarklet`.
- Persists snapshots to `~/.clauge/usage.json` (mode 0600).

### Dashboard polish
- **Headline strip** densified to 8 columns: API equivalent · Messages · Tool calls · Sessions · Subagents · Cache hit · Tokens · Primary model.
- **Token strip** below: Input · Output · Cache read · Cache 5m · Cache 1h · Net cache savings.
- **4 sparkline cards** (vanilla SVG, no deps): daily cost, daily calls, sessions/day, cache-hit-rate trend.
- **Hourly distribution** chart (24-hour UTC bar chart).
- **Breakdown tables** (Daily activity / By project / By activity / By model / Core tools / Shell commands / MCP servers) — every row has a horizontal bar showing share, plus precise counts and cost columns.
- **Sessions table** now shows turn count (Calls column) alongside tokens, hit %, cost.
- **Onboarding panel** when no claude.ai sync has happened — leads with "Install Clauge Sync extension" button + collapsible alternates (developer-mode install, bookmarklet).
- **Dollar values** rounded to whole dollars in the dashboard. CSV/JSON exports keep full precision.

### Backend additions
- New aggregator outputs per-session: `messageCount`, `toolCallCount`, `subagentTurnCount` (Agent/Task tool calls), `byHour` distribution.
- `rollupByProject` now carries through messages, tools, hit rate.
- `rollupByHour`, `rollupByTask` exports.
- New tests for `usage-store`, `bookmarklet`, period filtering, ROI calculation, exporter. **Total 113 tests passing.**

### Branding
- Brand-mark icon (Anthropic-coral meter gauge in dial) shipped in dashboard, README header, GitHub release notes, and as the extension icon.
- Browser favicon (SVG with PNG fallback).

### Distribution
- Chrome Web Store submission package: `docs/PRIVACY.md`, `docs/CWS_LISTING.md`, promo tile (440×280), 2 dashboard screenshots (1280×800).

## 0.1.2 (2026-05-06)

- Brand mark in dashboard nav bumped from 28×28 → 36×36 so it reads in the README screenshot.

## 0.1.1 (2026-05-06)

- Brand icon (meter gauge) shipped as favicon, dashboard nav mark, and README header.

## 0.1.0 (2026-05-06) — V1: Claude Code analytics

Initial V1 implementation per PRD v3.1.

**Library** (`lib/`):
- `parser.js` — JSONL stream reader with mandatory `requestId` deduplication (verified against real `~/.claude/projects/*.jsonl`).
- `cost-calculator.js` — LiteLLM auto-pricing (~/.cache → fetch → bundled fallback), two-tier cache rates, never reads `costUSD`.
- `classifier.js` — 8-category task classification with explicit precedence rules.
- `cache-analyzer.js` — corrected hit-rate + net-savings formulas.
- `tool-analyzer.js` — core tool / shell command / MCP server frequency analysis.
- `aggregator.js` — session / project / day / model rollups.
- `roi-calculator.js` — API replacement value with honest framing.
- `period.js` — period (today/7d/30d/month/all) + project filtering.
- `exporter.js` — CSV / JSON downloads.
- `session-store.js` — mtime-keyed in-memory cache.

**Server** (`server.js`):
- Hono server with all PRD §2.9 endpoints.
- Auto-opens browser on launch, clean SIGINT/SIGTERM shutdown.

**Dashboard** (`public/`):
- Editorial dark theme, intentional hierarchy.
- Period switcher + project filter + CSV/JSON export.

**Tests:** 93 passing across 31 suites.

**Verified live numbers (Adnan's Mac, 7d window, 488 sessions):**
- Total cost $1,363.77 (vs $200 subscription = 581.9% replacement value)
- Cache hit rate 98.24%, net cache savings $8,665
- Model split: 97% Opus 4.7, 3% Haiku 4.5
