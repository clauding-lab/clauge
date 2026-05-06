# Changelog

## 0.1.0 (2026-05-06) — Unreleased

Initial V1 implementation per PRD v3.1.

**Library** (`lib/`):
- `parser.js` — JSONL stream reader with mandatory `requestId` dedup
  (verified against real `~/.claude/projects/*.jsonl`, ~597 turns)
- `cost-calculator.js` — LiteLLM auto-pricing (~/.cache → fetch →
  bundled fallback), two-tier cache rates, never reads `costUSD`
- `classifier.js` — 8-category task classification with explicit
  precedence rules
- `cache-analyzer.js` — corrected hit-rate + net-savings formulas
- `tool-analyzer.js` — core tool / shell command / MCP server
  frequency analysis
- `aggregator.js` — session / project / day / model rollups
- `roi-calculator.js` — API replacement value with honest framing
- `period.js` — period (today/7d/30d/month/all) + project filtering
- `exporter.js` — CSV / JSON downloads
- `session-store.js` — mtime-keyed in-memory cache

**Server** (`server.js`):
- All PRD §2.9 endpoints wired:
  `/api/{health, summary, sessions, sessions/expensive,
  sessions/:id, projects, daily, models, tasks, tools, cache,
  roi, config, export}`
- Auto-opens browser on launch, clean SIGINT/SIGTERM shutdown

**Dashboard** (`public/`):
- Editorial dark theme, intentional hierarchy
- Period switcher + project filter (debounced)
- Five summary cards, API replacement value card with honest
  footnote, daily cost stacked bar, model breakdown doughnut,
  sessions table with top-5 expensive markers, top
  projects/tools/shell lists
- CSV/JSON export buttons

**Tests:**
- 93 tests / 31 suites, all passing
- Real-data integration verified end-to-end

**Verified live numbers (Adnan's Mac, 7d window, 488 sessions):**
- Total cost $1,363.77 (vs $200 subscription = 581.9% replacement)
- Cache hit rate 98.24%, net cache savings $8,665
- Model split: 97% Opus 4.7, 3% Haiku 4.5
