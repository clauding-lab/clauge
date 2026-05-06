# Changelog

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
