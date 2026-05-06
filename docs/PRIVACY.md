# Privacy Policy — Clauge & Clauge Sync

**Last updated:** 2026-05-06

Clauge is a self-hosted local dashboard for Claude Code analytics. Clauge Sync is a companion browser extension that automatically forwards your claude.ai plan-usage statistics to your local Clauge instance.

## Summary

**Clauge does not collect, transmit, or store any of your data on any third-party server. Everything stays on your own machine.**

## What Clauge (the local dashboard) does

- Reads Claude Code session log files at `~/.claude/projects/*.jsonl` on your local machine.
- Computes aggregate analytics (token counts, session counts, cost estimates, cache hit rate, etc.).
- Renders a dashboard at `http://localhost:3456` (the loopback address — only your machine can reach it).
- Optionally fetches model pricing from LiteLLM (`https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`) and caches it at `~/.cache/clauge/litellm-prices.json` for 24 hours. No personal data is included in this request.

Clauge does **not**:

- Send your Claude Code session contents anywhere.
- Send your token counts or cost estimates anywhere.
- Use telemetry, analytics, or crash reporting of any kind.
- Make any outbound network requests other than the LiteLLM pricing fetch above.

## What Clauge Sync (the browser extension) does

The extension is a thin pipe that runs in your browser and uses your already-authenticated claude.ai session to keep your local dashboard in sync.

When the extension fires (every minute by default, or when you click its icon):

1. Calls `https://claude.ai/api/organizations` to determine your organization UUID. Authenticated via the cookies your browser already holds for claude.ai.
2. Calls `https://claude.ai/api/organizations/{uuid}/usage` to retrieve your plan utilization (session %, weekly %, Sonnet %, extra usage, etc.).
3. POSTs the response **only** to `http://localhost:3456/api/usage/ingest` (or whatever local port you configured). The destination is the loopback address; the response never leaves your machine.

The extension stores in `chrome.storage.local`:

- The configured local port (default `3456`).
- The configured polling interval (default `1` minute).
- The result of the most recent sync (success/failure, timestamp, org name, session %), used by the popup to display status.

The extension does **not**:

- Read your claude.ai session cookie (it relies on the browser sending cookies automatically — the extension never reads or stores the cookie itself).
- Send any data to any server other than `https://claude.ai/api/*` (read) and `http://localhost/api/usage/ingest` (write).
- Use analytics, telemetry, or crash reporting.

## Permissions

The extension requests the following permissions and uses each strictly as described:

| Permission | Reason |
|---|---|
| `host_permissions: https://claude.ai/*` | Read your usage statistics from claude.ai's API |
| `host_permissions: http://localhost/*`, `http://127.0.0.1/*` | POST the snapshot to your local Clauge dashboard |
| `alarms` | Schedule the periodic sync (default every minute) |
| `storage` | Save your port and interval preferences |

## Open source

Both the dashboard and the extension are open source under the MIT license. You can audit every line of code at https://github.com/clauding-lab/clauge.

## Contact

For privacy questions, security reports, or anything else, file an issue at https://github.com/clauding-lab/clauge/issues.
