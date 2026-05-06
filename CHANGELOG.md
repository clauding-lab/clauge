# Changelog

## 0.1.0 (2026-05-06) — Unreleased

Initial scaffold per PRD v3.1.

- Hono server skeleton + auto-open browser on start
- `lib/parser.js` with mandatory `requestId` deduplication for assistant turns
- Schema verified against real `~/.claude/projects/*.jsonl` (4 sessions, ~597 turns)
- Test scaffold using Node's built-in `node:test`
