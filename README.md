# Clauge

Claude + Gauge. Token analytics and subscription ROI for Claude Code.

> **Status:** V1 scaffold (per PRD v3.1, build step 9 of 20). Parser + Hono server skeleton are live; full dashboard arrives over the next build phases.

## Quick start

```bash
npx github:clauding-lab/clauge
```

Or local:

```bash
git clone https://github.com/clauding-lab/clauge.git
cd clauge && npm install && cp .env.example .env
node server.js
# → http://localhost:3456 (auto-opens browser)
```

## What it does (when finished)

- **Per-session tracking** — tokens, cost, model, cache hit, task type
- **Per-project breakdown** — which projects burn the most
- **Per-model cost split** — Opus vs Sonnet vs Haiku
- **Task classification** — Coding, Debugging, Testing, Planning, Git Ops, Build, Exploration, Conversation
- **Cache performance** — hit rate (with two-tier cache pricing) and net savings (accounting for write overhead)
- **Tool / shell / MCP analytics** — what Claude Code actually does
- **Subscription value** — your subscription's API replacement value
- **Burn rate** — tokens per hour, average cost per session
- **Period filtering** — Today, 7 days, 30 days, month, all time
- **Export** — CSV and JSON

## Why it exists

Five apps track Claude usage. None provide token-level Claude Code analytics. None compute subscription value vs API equivalent spend. None tell you what to do about your usage. Clauge does all three.

## Architecture (V1)

```
~/.claude/projects/{path-encoded-dir}/{session_uuid}.jsonl
    │
    ▼
JSONL stream parser (lib/parser.js)
    │  filters: type IN (assistant, user)
    │  dedups assistant turns by .requestId
    ▼
Per-turn extractor → aggregator → Hono REST API → HTML dashboard
```

**Key correctness invariant:** Claude Code emits 1–3 JSONL lines per assistant request (one per content-block type), each with **identical** `usage` numbers. The parser dedups by `requestId` — without this, every cost is multiplied 2–3×. See `lib/parser.js` and `test/parser.test.js`.

## Development

```bash
npm test          # run parser unit tests (node:test built-in)
npm run dev       # auto-restart server on changes
npm start         # plain start
```

Set `NO_OPEN=1` to skip auto-opening the browser.

## License

MIT — see LICENSE.

Built by [clauding-lab](https://github.com/clauding-lab).
