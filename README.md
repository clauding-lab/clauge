<p align="center">
  <img src="docs/icons/clauge-icon-512.svg" alt="Clauge" width="120" height="120" />
</p>

<h1 align="center">Clauge</h1>

<p align="center">
  <strong>Know what your Claude subscription is actually worth.</strong><br/>
  A native macOS menu-bar app (and Windows desktop app) that turns your local Claude&nbsp;Code logs and claude.ai plan usage into one glanceable dashboard — cost, plan limits, cache savings, and subscription ROI.<br/>
  Plus the <strong>Clauge Widget</strong>: your entire Claude&nbsp;Code statusline — quota gauges, model buckets, session hygiene — rendered by <code>clauge status</code>.
</p>

<p align="center">
  <a href="https://apps.apple.com/us/app/clauge/id6770303247"><img src="https://img.shields.io/badge/Mac_App_Store-Download-0D96F6?logo=apple&logoColor=white" alt="Download on the Mac App Store" /></a>
  <a href="https://apps.apple.com/us/app/clauge-token-analytics/id6777443865"><img src="https://img.shields.io/badge/App_Store_(iOS)-Download-0D96F6?logo=apple&logoColor=white" alt="Download Clauge - Token Analytics on the App Store" /></a>
  <a href="https://github.com/clauding-lab/clauge/releases/latest"><img src="https://img.shields.io/github/v/release/clauding-lab/clauge?label=release&color=d97757" alt="Latest release" /></a>
  <a href="https://github.com/clauding-lab/clauge/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/clauding-lab/clauge/check.yml?branch=main&label=CI" alt="CI status" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license" /></a>
</p>

![Clauge — your Claude usage, at a glance](docs/screenshots/v1.0.0/hero.png)

---

Clauge reads usage data your own tools have already written to your machine and presents it as analytics. There is **no login screen, no API key field, and no telemetry** — it is a local reader, closer to Activity Monitor than to a SaaS app. Your usage data never leaves your computer.

- **Claude Code** — token usage, cost, cache savings, models, tools, and projects, parsed from the local session logs at `~/.claude/projects/`.
- **claude.ai** — plan limits (session / weekly / model-scoped buckets like the current "Fable"), prepaid balance, and overage spend, synced from your signed-in browser tab by the optional [Clauge Sync](https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga) extension. Bucket names come straight from claude.ai, so when Anthropic renames or adds one, Clauge follows without an update.

## Install

### macOS

| Method | Command / link |
|---|---|
| **Mac App Store** *(recommended — sandboxed, auto-updates through the Store)* | [**Download Clauge**](https://apps.apple.com/us/app/clauge/id6770303247) |
| Homebrew | `brew install --cask clauding-lab/tap/clauge` |
| Direct download | Universal DMG from [Releases](https://github.com/clauding-lab/clauge/releases/latest) → drag `Clauge.app` to Applications |

Clauge lives in your menu bar. **Left-click** for the glanceable popover; **right-click** for Dashboard (⌘D), Preferences, Check for Updates, and Quit.

<p align="center">
  <img src="docs/screenshots/v1.0.0/popover.png" alt="Clauge menu-bar popover" width="300" />
</p>

The popover shows paired **Session** + **Weekly** gauges (each with its local reset time), a bar per **model-scoped limit** (currently claude.ai's "Fable" weekly bucket — labeled live from the wire), daily routine runs, month-to-date overage and prepaid balance, a 30-day spend chart, and a 180-day activity heatmap.

> **First launch.** A short Welcome wizard explains the one permission Clauge needs on macOS: read access to the OAuth credential Claude&nbsp;Code already stored in your Keychain. macOS will prompt *"Clauge wants to use … 'Claude Code-credentials' …"* — click **Always Allow**. Clauge never sees your Anthropic password, API key, or session token; it reads only the credential blob Claude&nbsp;Code itself wrote. You can skip this and grant it later from **Settings → Connections → ↻ Refresh**.

### iOS

A free, read-only **iPhone companion** — *Clauge - Token Analytics* — that shows your Claude usage at a glance on the go.

| Method | Link |
|---|---|
| **App Store** | [**Download Clauge - Token Analytics**](https://apps.apple.com/us/app/clauge-token-analytics/id6777443865) — iPhone, iOS 17+, free |

### Windows

Download `Clauge_<version>_x64-setup.exe` from [Releases](https://github.com/clauding-lab/clauge/releases/latest) and run it. The installer is **per-user (no admin prompt)** and installs to `%LOCALAPPDATA%\Clauge`.

The Windows build is not yet code-signed, so you'll click through two first-run warnings (Authenticode signing is planned):

1. **Browser download** — Edge/Chrome may flag the `.exe` as "uncommon." Expand the bar → **Keep** (Chrome) or **More info → Keep anyway** (Edge).
2. **SmartScreen on launch** — "Windows protected your PC" → **More info** → **Run anyway**.

Clauge is open source and reproducible from each tagged release, so you can audit or rebuild it yourself. Two notes on the current Windows build: there is **no system-tray icon** (close the dashboard window to quit; relaunch from the Start Menu), and the in-app claude.ai sign-in is **macOS-only** — on Windows, use the [Clauge Sync extension](#browser-extension-for-claudeai-data) for plan data. Auto-updates work the same as on macOS (Settings → Updates → Check Now).

### Linux / headless

```bash
git clone https://github.com/clauding-lab/clauge.git
cd clauge && npm install
node server.js   # serves the dashboard at http://localhost:3456
```

Runs the same server the native apps embed, as a plain browser dashboard (no menu bar, no native popover, no auto-updater). The old `npx clauge` route is retired — the npm package is stale and no longer maintained.

> Claude&nbsp;Code analytics need **no sign-in** on any platform — the data is already on disk. If you've used Claude&nbsp;Code on this machine, the dashboard populates on first open.

## The Clauge Widget (`clauge status`)

Your **entire Claude Code statusline, rendered by Clauge** — no third-party statusline tool in the loop. One command wires it in:

```bash
clauge status --install   # wire into ~/.claude/settings.json (backs up first; --force to replace an existing statusline)
clauge status             # the three-line render (exit 0 always — statusline-safe)
clauge status --json      # the /v1/usage envelope for scripts (non-zero exit when the app is down)
```

```text
Opus 4.8 · ~/Projects/clauge · +267/-0 · ⧗ 42m · main
Session ▓▓░░░░░░░░ 20% (resets 2h) · Weekly ▓░░░░░░░░░ 9% (resets 5d)
Fable ▓▓▓▓▓▓▓░░░ 68% (resets 4d) · Context Used 46% · Compactions 0
```

- **Line 1 — working context**, from Claude Code's own session payload: model · path · lines added/removed · runtime · git branch.
- **Line 2 — your quota.** Session and Weekly gauges color independently (green < 75%, orange ≥ 75%, red ≥ 90%).
- **Line 3 — model buckets and hygiene.** Model-scoped buckets — like claude.ai's current **"Fable"** weekly limit — get their own gauge, named live from the wire and rendered in **blue** so they read apart from the warning colors; when Anthropic renames or adds a bucket, the widget follows automatically. Then Context Used and a compaction counter, in yellow — red when context hits 90% or compactions hit 2. (Spend and ROI live in the popover, dashboard, and `/v1` API.)

If the app is briefly down, the widget serves last-known data from `~/.clauge/statusline-cache.json` with an age tag — it never blanks and never breaks your prompt. `--plain` or `NO_COLOR` strips colors; `--max-width <n>` truncates.

**Updating the widget:** `brew upgrade clauge-cli` is the whole update — nothing else to run. `--install` wires the statusline to Homebrew's version-stable path (`/opt/homebrew/opt/clauge-cli/bin/clauge`), which always tracks the current version, and Claude Code re-runs that command on every render — so open terminals show the new widget on their next redraw, with no reinstall and no restart. If the widget ever looks frozen after an upgrade, run the exact command stored in `~/.claude/settings.json` by hand: three lines out means the widget is healthy (the terminal just hasn't redrawn); an error means the command path is broken — re-run `clauge status --install --force` to rewire it. (Statuslines installed by v1.3.7 or earlier pinned a versioned path that breaks on upgrade — one `clauge status --install --force` after upgrading moves you to the stable path for good.)

## Browser extension (for claude.ai data)

The Claude&nbsp;Code metrics work on their own. To also see your **claude.ai plan usage and balance**, install **Clauge Sync** — it runs in your already-authenticated claude.ai tab and posts a usage snapshot to your local Clauge once a minute.

→ **[Clauge Sync on the Chrome Web Store](https://chromewebstore.google.com/detail/clauge-sync/ailfbgegpplecgcadlkplkllobepfcga)** (Chrome, Edge, Brave, Arc, any Chromium browser)

Then just stay signed in to [claude.ai](https://claude.ai) in that browser profile. The extension rides your existing session — **it never asks for an API key, password, or token.** If you sign out, it goes quiet until you sign back in.

*Why an extension?* claude.ai sits behind Cloudflare's bot protection, so a server-side request from Clauge can't reach it. The extension runs *inside* your browser, where Cloudflare already trusts you — the well-behaved equivalent of checking your own plan page once a minute. There is no public API for personal-plan claude.ai usage, which is why Clauge has no API-key flow at all.

## How your data stays private

Clauge holds **no account, no Anthropic credentials, and no session tokens** — so there's nothing to leak, rotate, or phish.

| Source | Covers | Comes from | Auth |
|---|---|---|---|
| Claude&nbsp;Code logs | Per-session tokens, cost, models, tools, projects | `~/.claude/projects/**/*.jsonl` (written by Claude&nbsp;Code) | None — local file read |
| claude.ai plan data | Session/weekly/model-scoped limits, balance, overage | Clauge Sync, riding your browser session | Your normal claude.ai login |

Anthropic sees a request from *your* browser; Clauge sees a local HTTP POST to its own port. No telemetry, no phone-home — Clauding-Lab doesn't know you exist. The full policy is in [PRIVACY.md](PRIVACY.md).

## Features

The dashboard (⌘D, or right-click → Open Dashboard) is the full view — plan capacity, an analytics digest, cost-over-time, and peak hours:

<p align="center">
  <img src="docs/screenshots/v1.0.0/dashboard.png" alt="Clauge dashboard" width="860" />
</p>

**Claude Code analytics** (from local logs)

- Per-session tracking — tokens, cost, model, cache-hit rate, primary task type
- Per-project rollup — cost · sessions · messages · tools · hit %
- Per-model cost split (Opus / Sonnet / Haiku) with cache-hit rates
- Task classification — coding / debug / test / plan / git / build / exploration (deterministic)
- Cache analytics — corrected hit rate and **net savings** (5-minute vs 1-hour tiers, minus write overhead)
- Tool / shell / MCP usage, peak-hours distribution, and a 180-day **activity heatmap** with streaks
- **Subscription value** — how much retail API spend your usage would have cost, with honest framing
- Period (Today / 7d / 30d / Month / All) and project filters; CSV / JSON export

**claude.ai plan tracking** (via the extension)

- Live **plan gauges** — Session (5h), Weekly (7d), and every model-scoped bucket claude.ai reports (currently "Fable", 7d) — color-coded by usage, labeled from the wire, each with the **local reset time** beneath its countdown
- Prepaid **balance** and **month-to-date overage** against your cap
- Refreshes about once a minute and updates in place

## Command-line interface

The same binary that backs the dashboard doubles as a CLI — handy for scripting and headless setups.

```bash
clauge config get                              # config as JSON (HTTP-first, falls back to disk)
clauge config providers [--json]               # list providers + enabled state
clauge config enable  --provider claude-ai-session
clauge config disable --provider clauge-sync
echo "$KEY" | clauge config set-api-key --provider anthropic-admin --stdin
clauge --help    |    clauge --version
```

The Mac app bundle ships the CLI wrapper at `Contents/Resources/Resources/clauge-cli` (working from v1.3.4 — earlier builds shipped it broken); symlink it onto your `PATH`, or let the dashboard install the symlink for you. Homebrew installs put `clauge` on `PATH` automatically (cask v1.3.4+). **Mac App Store installs:** the sandbox blocks terminal use of the bundled CLI — install the standalone one instead: `brew install clauding-lab/tap/clauge-cli` (same verbs, talks to your running MAS app). `set-api-key` only accepts the key via stdin (never on the command line) and is macOS-only for now.

## Local API (`/v1/usage`)

While Clauge is running, other local tools (statuslines, scripts, dashboards) can read your usage without parsing any logs themselves — a stable, versioned, **loopback-only** JSON API:

```bash
# 1. Find the live port (never hardcode 3456 — it can shift to 3457-3460)
PORT=$(cat ~/Library/Caches/Clauge/active-port)   # Windows: %LOCALAPPDATA%\Clauge\active-port

# 2. Read the snapshot
curl http://127.0.0.1:$PORT/v1/usage          # array of provider snapshots
curl http://127.0.0.1:$PORT/v1/usage/claude   # single snapshot (204 = no data yet)
```

Each snapshot carries `apiVersion`, `providerId`, and a `lines[]` array of typed entries — `progress` lines (Session/Weekly %, plus one per scoped bucket, e.g. `Weekly (Fable)`, with `resets_at`) and `text` lines (Spend, ROI) — so consumers render on `type` + `label` and new lines never break them. The schema is wire-compatible with [aiusage](https://github.com/ahsanhabibakik/aiusage) consumers. Loopback-only by design: the server binds `127.0.0.1` and rejects any request whose `Host` header isn't a loopback name.

## Configuration

Optional `.env` (copy from `.env.example`):

```bash
PORT=3456                 # dashboard port
CLAUDE_DIR=~/.claude      # source directory for Claude Code logs
SUBSCRIPTION_COST=200     # monthly cost used for the API-replacement-value calc

# Per-1M-token fallback rates for models LiteLLM doesn't list
RATE_INPUT=3.00
RATE_OUTPUT=15.00
RATE_CACHE_READ=0.30
RATE_CACHE_CREATE=3.75
RATE_CACHE_CREATE_1H=6.00
```

## How it works

```
~/.claude/projects/<dir>/<session>.jsonl ──► JSONL parser ──► aggregator ──┐
                                                                            ▼
claude.ai usage (via extension, your cookies) ──────────────► Hono REST API
                                                                            │
                                                                            ▼
                                                              dashboard + menu-bar UI
```

- **Dedup invariant:** Claude&nbsp;Code emits 1–3 JSONL lines per assistant request (one per content block) with identical `usage` numbers; the parser dedups by `requestId`. Without it, every cost is 2–3× too high.
- **Pricing:** model rates come from [LiteLLM](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) (cached 24h, with a bundled offline fallback), with 5-minute vs 1-hour cache tiers priced separately. The `costUSD` field in the logs is never trusted — cost is always recomputed.
- **Local only:** the sidecar binds to `127.0.0.1`; read endpoints are restricted to the app's own loopback origins, and the app only ever trusts a sidecar it launched itself.

### API

The local server (`http://localhost:3456`) exposes a small read API — `GET /api/summary`, `/sessions`, `/sessions/expensive`, `/sessions/:id`, `/projects`, `/daily`, `/models`, `/tasks`, `/tools`, `/cache`, `/hours`, `/roi`, `/activity`, `/usage`, `/export`, `/bookmarklet`, `/health`, `/config` — plus two writes: `POST /api/usage/ingest` (the extension target, origin-restricted to claude.ai + extension origins) and `POST /api/config/providers/:name` (the provider toggle the CLI uses).

## Development

```bash
git clone https://github.com/clauding-lab/clauge.git
cd clauge && npm install
node server.js        # run the dashboard locally (NO_OPEN=1 to skip auto-open)

npm test              # Node test runner
npm run dev           # auto-restart on changes
npm run check         # full CI gate: validators + cargo fmt + clippy + cargo test + npm test
```

The native shell is [Tauri 2](https://tauri.app) (`src-tauri/`); the dashboard/popover are served by a Node sidecar bundled as a single executable. See [AGENTS.md](AGENTS.md) for build/release conventions and [CHANGELOG.md](CHANGELOG.md) for version history.

## Roadmap

- **Code signing** — DMG notarization (macOS) and Authenticode (Windows) to remove the unidentified-developer / SmartScreen warnings on the direct-download builds.
- **claude.ai sign-in on Windows** — native OAuth parity with macOS (Windows currently relies on the extension for plan data).
- **Linux build** — needs a dedicated menu-bar / tray surface design.
- **Pace projections** — reset-aware guidance (approaching cap, session reset imminent, weekly-vs-scoped-bucket routing).

## Why Clauge

Plenty of tools track Claude usage, but none give **token-level analytics for Claude&nbsp;Code**, and none compute what your **subscription is worth versus retail API pricing** at your real usage. Clauge does both natively and puts your Claude&nbsp;Code spend and claude.ai plan limits side by side.

## Contributing & security

- Patches: see [CONTRIBUTING.md](CONTRIBUTING.md) — commit style, `npm run check`, and where issues go.
- Found a vulnerability? See [SECURITY.md](SECURITY.md) — please don't open a public issue.

## License

MIT — see [LICENSE](LICENSE). Built by **Adnan Rashid** · Copyright © 2026 Adnan Rashid.
