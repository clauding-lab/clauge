<p align="center">
  <img src="docs/icons/clauge-icon-512.svg" alt="Clauge" width="128" height="128" />
</p>

<h1 align="center">Clauge</h1>

<p align="center">
  Token analytics and subscription value dashboard for <strong>Claude Code</strong> + <strong>claude.ai</strong>.<br/>
  Local Node.js + HTML, <code>npx</code>-installable. Browser extension auto-syncs claude.ai plan usage.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clauge"><img src="https://img.shields.io/npm/v/clauge.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/clauge.svg" alt="license" /></a>
</p>

![Clauge dashboard](docs/screenshots/v0.5.0/dashboard-v2.png)

<p align="center">
  <img src="docs/screenshots/v0.5.0/popover-v2.png" alt="Clauge menu-bar popover" width="380" />
</p>

> Status: **V3 — native macOS app** (universal Apple Darwin DMG, signed auto-updater) plus the existing `npx clauge` browser dashboard. v0.5.0 ships a native NSPopover menu-bar surface (persists across app deactivation) and a compact 1100×800 dashboard.

## Install

### Native macOS app (v3, recommended)

Download the latest universal DMG from [Releases](https://github.com/clauding-lab/clauge/releases/latest), drag Clauge.app to Applications, and launch. The app sits in the menu bar — left-click for a glanceable popover (Plan Capacity rings + Finance + Today), right-click for Open Dashboard / Preferences / Check for Updates / Quit. Auto-updates from gh-pages on each launch.

### Browser dashboard (v2, still supported)

```bash
npx clauge
```

Installs from npm and opens **http://localhost:3456**. Reads from `~/.claude/projects/` by default. Same data model as the native app — pick whichever surface fits your workflow.

## What it does

### Claude Code analytics (from local JSONL)

- **Per-session tracking** — tokens, cost, model, cache hit, primary task type
- **Per-project breakdown** — cost · sessions · messages · tools · tokens · hit %
- **Per-model cost split** — Opus / Sonnet / Haiku, each with cache hit rate
- **Task classification** — Coding / Debugging / Testing / Planning / Git Ops / Build / Exploration / Conversation (heuristic, deterministic)
- **Cache analytics** — corrected hit-rate formula and **net cache savings** (subtracts cache-write overhead, distinguishes 5-minute vs 1-hour cache tiers)
- **Tool / shell / MCP analytics** — what Claude Code actually does
- **Peak hours** — UTC hourly distribution of calls and cost
- **Subscription value** — how much retail API spend your subscription replaces, with honest framing
- **Period filtering** — Today / 7d / 30d / Month / All Time
- **Project filter** — case-insensitive substring match
- **Export** — CSV and JSON for any period + project filter

### claude.ai plan tracking (via browser extension)

- **5 ring gauges** — Session (5h), All models (7d), Sonnet (7d), Opus (7d), Claude Design — green/amber/red by 60/85% thresholds, with reset countdowns
- **Extra-usage card** — your billing cap with progress bar
- **Auto-refresh every minute** via the [Clauge Sync](#claudeai-auto-sync) browser extension; the dashboard polls the local store and updates the gauges in place

### From source

```bash
git clone https://github.com/clauding-lab/clauge.git
cd clauge && npm install && cp .env.example .env
node server.js
```

Set `NO_OPEN=1` to skip the auto-open. Set `CLAUDE_DIR=~/somewhere-else` to read from a non-default location.

## claude.ai auto-sync

claude.ai sits behind Cloudflare's bot challenge, so server-side fetch from this app can't reach the API directly. Auto-sync is therefore handled by a companion browser extension that runs in your already-authenticated tab.

### Option A — browser extension (recommended)

The **Clauge Sync** extension polls `claude.ai/api/organizations/{uuid}/usage` every minute (configurable) using your normal browser session and POSTs the snapshot to your local Clauge instance.

- **Chrome Web Store:** *(pending review — link will appear here once published)*
- **Manual install (developer mode):**
  1. Open `chrome://extensions` and toggle **Developer mode**
  2. Click **Load unpacked** and pick `extension/` from this repo
  3. Make sure you're signed in to [claude.ai](https://claude.ai) in the same browser profile

Click the toolbar icon at any time to force an immediate sync. Right-click → **Options** to change port or interval.

### Option B — bookmarklet (no extension)

The dashboard's "claude.ai plan usage" card includes a draggable bookmarklet. Drag it to your bookmarks bar, open claude.ai, click the bookmark — the snapshot syncs once. Reuse whenever you want a fresh number.

## How it works

```
~/.claude/projects/{path-encoded-dir}/{session_uuid}.jsonl
    │
    ▼                                 ┌────────────────────────┐
JSONL stream parser (lib/parser.js)   │  Browser extension     │
    │  dedups assistant turns by      │  (or bookmarklet)      │
    │  .requestId                     │  reads claude.ai usage │
    ▼                                 │  with user's cookies   │
Per-turn extractor → aggregator       └────────────┬───────────┘
    │                                              │
    └──────────────► Hono REST API ◄───────────────┘
                            │
                            ▼
                     HTML dashboard
                     (http://localhost:3456)
```

**The single most important invariant:** Claude Code emits 1–3 JSONL lines per assistant request (one per content-block type: thinking / text / tool_use), each with **identical** `usage` numbers. The parser dedups by `requestId` — without this, every cost is multiplied 2-3×. See `lib/parser.js` and `test/parser.test.js`.

**Pricing:** model rates come from [LiteLLM's `model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) (cached locally for 24h, with a bundled offline fallback). Two-tier cache writes (`ephemeral_5m` vs `ephemeral_1h`) are priced separately. The `costUSD` field is never read — cost is always recomputed so rate-preset changes propagate to history.

**Subscription value framing:** the headline number tells you how much retail API spend your subscription replaces *at observed token usage*. It does **not** tell you whether your plan is worth keeping — most users would cut back if they paid retail rates. Card copy includes this caveat.

## Configuration

`.env` (optional — copy from `.env.example`):

```
PORT=3456                 # dashboard port
CLAUDE_DIR=~/.claude      # source directory
SUBSCRIPTION_COST=200     # for the API replacement value calc

# Per-1M-token rate fallbacks for models LiteLLM doesn't have
RATE_INPUT=3.00
RATE_OUTPUT=15.00
RATE_CACHE_READ=0.30
RATE_CACHE_CREATE=3.75
RATE_CACHE_CREATE_1H=6.00
```

## Development

```bash
npm test          # 113 unit tests via Node's built-in test runner
npm run dev       # auto-restart server on changes
npm start         # plain start
```

## API

| Endpoint | Returns |
|---|---|
| `GET /api/summary?period=7d&project=X` | totals, primary model, message/tool/subagent counts |
| `GET /api/sessions?period=7d` | list of session summaries |
| `GET /api/sessions/expensive?limit=5` | top-N most expensive sessions |
| `GET /api/sessions/:id` | one session summary |
| `GET /api/projects?period=7d` | per-project rollup |
| `GET /api/daily?period=30d` | daily totals + per-project breakdown |
| `GET /api/models?period=7d` | per-model cost + cache hit |
| `GET /api/tasks?period=7d` | task category breakdown |
| `GET /api/tools?period=7d` | core tools / shell commands / MCP servers |
| `GET /api/cache?period=30d` | hit rate + net savings + daily trend |
| `GET /api/hours?period=7d` | 24-hour activity distribution (UTC) |
| `GET /api/roi?period=7d` | API replacement value |
| `GET /api/export?format=csv&period=7d` | CSV / JSON export |
| `GET /api/usage` | latest claude.ai plan-usage snapshot |
| `POST /api/usage/ingest` | extension/bookmarklet target — CORS-restricted to claude.ai + extension origins |
| `GET /api/bookmarklet` | the bookmarklet code as `javascript:` href + readable source |
| `GET /api/health`, `/api/config` | service info |

## What's coming

- **Windows + Linux DMG/MSI builds** — same Tauri codebase, just need cross-compile setup
- **Intelligence banner** with pace projections (priority rules: extra usage near cap, session reset imminent, weekly-vs-Sonnet routing hints, etc.)
- **One-shot success rate** per task category
- **Per-project drill-down view** with sessions, files edited, tools used

## Why

Five apps track Claude usage. None provide token-level analytics for Claude Code. None compute subscription value vs API equivalent at observed usage. None tell you what to do about your usage. Clauge does the first two natively, plus pulls claude.ai plan utilisation into the same dashboard so you see Code spend and plan limits side-by-side.

## License

MIT — see [LICENSE](LICENSE). Privacy policy in [docs/PRIVACY.md](docs/PRIVACY.md).

Built by [clauding-lab](https://github.com/clauding-lab).
