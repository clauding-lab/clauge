# Clauge `/v1/usage` — Local Loopback JSON API (Handoff / Design Brief)

**Date:** 2026-07-16 (BDT)
**Status:** AWAITING OWNER SIGN-OFF — this is a "New feature" per `VISION.md:20`; do not merge without Adnan's explicit approval of the design below.
**Origin:** Written by a harness session on Adnan's Mac after (a) a full source dissection of `ahsanhabibakik/aiusage` (the tool that proved the idea) and (b) a full recon of this repo by a read-only explorer agent. Every file:line cited below was verified against `main` at v1.3.3 (commit `66b8a5e`) on 2026-07-16.
**Audience:** A future Claude session opening cold in `~/Projects/clauge`. This document is self-contained — you do not need the original conversation.

---

## 1. Mission in one paragraph

Expose Clauge's already-computed usage numbers through a **stable, versioned, loopback-only JSON API** — `GET http://127.0.0.1:<port>/v1/usage` — so other local tools (ccstatusline custom-command widgets, Mission Control, shell scripts, future tuistatus tools) can consume session/weekly %, spend, and ROI **without re-parsing `~/.claude/projects` JSONL themselves** (and without re-solving the requestId-triplication dedup Clauge already solved). The idea is proven by `aiusage` (github.com/ahsanhabibakik/aiusage, MIT, Python), whose local API at `127.0.0.1:8737/v1/usage` is its best feature. Clauge should adopt the *schema and architecture invariants*, not the code.

## 2. Headline recon finding: the server already exists

**This is a route addition, not a new server.** The Node sidecar (`server.js`) is a full Hono 4 HTTP server bound to `127.0.0.1` (default port 3456 at `server.js:70`, fallback 3456–3460 via `listenWithRetry` at `server.js:859-896`), already serving ~25 JSON endpoints under `/api/*`, including `GET /api/usage`, `/api/summary`, `/api/snapshot`, `/api/roi`, `/api/projection`. Hono `^4.6.14` + `@hono/node-server ^1.13.7` are existing prod deps (`package.json:48-53`). **No new dependency. No new process. No Tauri IPC change. No SEA-manifest change.**

Consequences:
- The three famous landmines (IPC triple-registration `AGENTS.md:145-155`, SEA two-manifest mirror `AGENTS.md:157-171`, platform webview URLs `AGENTS.md:172-179`) **do not apply** to a server-side JSON route. Landmine #39 (`AGENTS.md:696`) says it explicitly: server-side `lib/` modules need NO `sea-config.json` entry — esbuild bundles them via the import graph.
- The MAS sandbox is already entitled: `src-tauri/entitlements.mas.plist:24-26` grants `com.apple.security.network.server` for the loopback sidecar (the sidecar Helper inherits it via `src-tauri/entitlements-sidecar.mas.plist` `inherit=true`). **No entitlement work needed** for either build flavor (DMG is non-sandboxed anyway).
- `VISION.md:25` ("new long-running processes need sign-off") is not triggered — we ride the existing sidecar.

## 3. The schema to adopt (from aiusage, verified against its source)

aiusage's core idea — its single best design decision — is a **normalized provider envelope with a typed line vocabulary**, so every consumer renders blindly on `type` + `label` and new providers cost nothing on the consumer side:

```jsonc
// GET /v1/usage  →  200, array of provider snapshots
[
  {
    "apiVersion": 1,                    // Clauge addition — see §5
    "providerId": "claude",
    "displayName": "Claude",
    "plan": "Max 5x",                   // nullable
    "lines": [
      { "type": "progress", "label": "Session", "used": 4.0,  "limit": 100.0,
        "format": {"kind": "percent"}, "resets_at": "2026-07-16T00:50:00Z" },
      { "type": "progress", "label": "Weekly",  "used": 89.0, "limit": 100.0,
        "format": {"kind": "percent"}, "resets_at": "2026-07-15T23:00:00Z" },
      { "type": "text", "label": "Today", "value": "$4.48 · 8.4M tokens",
        "models": [{"model": "fable-5", "cost": 3.9, "tokens": 7800000}] },
      { "type": "text", "label": "ROI", "value": "3.2x vs API" }
    ],
    "fetchedAt": "2026-07-16T02:10:00Z"
    // "error": "..."   ← key OMITTED entirely when null
  }
]
```

Reference implementation (Python, in aiusage): `src/aiusage/models.py:6-49` — two dataclasses, `ProviderSnapshot` + `MetricLine`. Wire rules worth copying exactly:
- **`to_dict` drops every `None` field** (`models.py:27-29`) — each line carries only fields relevant to its `type`. Tight, self-describing.
- **Line types:** `progress` (used/limit/format/resets_at/pace), `text` (value, optional per-model breakdown), `barChart` (points[], for trends). `badge` is declared but unused — don't port cruft.
- **Error taxonomy** (`claude.py:51-58`): `rate_limited` (429) vs `not_logged_in` (401/403) vs `request_failed` (other) — prevents "throttle looks like logout". Adopt these exact states in the snapshot `error` field.
- **Stale-but-shown** (`claude.py:270-280`): if fresh data is unavailable, serve the last good value plus a `text` line noting age + cause; never serve blank.
- **snake_case internals, camelCase wire** for the envelope (`providerId`, `displayName`, `fetchedAt`); `lines[]` fields stay snake-ish (`resets_at`) in aiusage — Clauge may normalize to camelCase throughout; pick one and freeze it.

## 4. What Clauge already computes (reuse, don't re-derive)

| Data | Source module | Notes |
|---|---|---|
| Session/weekly % + resets | `lib/usage-store.js` → `~/.clauge/usage.json` | Ingested from the Clauge Sync browser extension via `POST /api/usage/ingest` (`server.js:758-809`). Normalizes to camelCase output keys `fiveHour`/`sevenDay`/`sevenDaySonnet`/`sevenDayOpus`, each `{pct, resetsAt}` (`usage-store.js:146-189`); overage lives separately as `extraUsage` with a richer shape (`enabled/limitCents/usedCents/…/pct`, `:173-187`), not `{pct, resetsAt}`. **No server-side Anthropic call exists in main.** |
| Spend/tokens (deduped!) | `lib/parser.js:99-133` via `lib/session-store.js` | requestId dedup at `parser.js:112-119` — data contract #1 (`AGENTS.md:104`). Costs recomputed from LiteLLM rates (`lib/cost-calculator.js`), never from `costUSD` (contract #3). |
| ROI | `lib/roi-calculator.js` (`apiReplacementValue`) | The Clauge differentiator — aiusage has nothing like it. Surface it as a `text`/`progress` line. |
| Forecast | `lib/projection.js` | Optional `progress`-with-`pace` line (aiusage's `pace.verdict: ok|tight|over` maps well). |
| Curated aggregate | `lib/snapshot.js::buildSnapshot` (`:276-320`) | Schema-versioned mirror built for iOS. **Do NOT reuse `SNAPSHOT_SCHEMA_VERSION` for `/v1`** — it's a cross-repo iOS contract (landmines #37/#42, `AGENTS.md:688,708`). Copy the shape if useful, under `/v1`'s own version. |

Bucket taxonomy note (verified 2026-07-16): Anthropic's usage surfaces expose `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` — **no Fable bucket exists yet**. When one appears, add it as another `progress` line labeled `Weekly (Fable)`; consumers keyed on type+label will render it with zero changes. That's the payoff of the schema.

## 5. Recommended design: **B — versioned contract module** (A is the fallback)

- **Design B (recommended):** new `lib/api-v1.js` exporting a Hono sub-app; mount in `server.js` with `app.route('/v1', v1App)` **before** the static catch-all (`server.js:857`). Contains `const V1_API_VERSION = 1`, pure builder functions (`buildV1Usage({usageStore, store, roi, clock})`), JSDoc contract. Decouples the *public, external* contract from churny internal `/api/*`. Server-side module ⇒ no SEA manifest edit (landmine #39).
- **Design A (minimal fallback):** ~15 lines directly in `server.js` aliasing `/api/usage` + `/api/roi` into the frozen shape. Acceptable if the owner wants the smallest possible PR; migrate to B when a second consumer appears.
- **Rejected — C:** exposing `buildSnapshot` verbatim as `/v1/usage`; couples external consumers to the iOS release train (see §4 caveat).

Endpoints (mirror aiusage's surface, `server.py:75-107`):
- `GET /v1/usage` → array of all provider snapshots (Clauge today = just `claude`)
- `GET /v1/usage/claude` → single snapshot; `404 {"error":"provider_not_found"}` unknown id; `204` if no data yet

**Empty-vs-stale rule (binding):** `204` applies ONLY when no usage has *ever* been ingested (cold install, `~/.clauge/usage.json` absent/empty); the array form returns `[]` in that state. Once any data has existed, serve the last-good snapshot with a `text` line noting age + cause (the §3 stale-but-shown rule) — never a blank response. These two rules reconcile: `204`/`[]` = "never had data"; stale-but-shown = "had data, currently can't refresh".

## 6. Security: match Clauge's bar, exceed aiusage's

aiusage's loopback claims verified TRUE in source (binds `127.0.0.1` only, `server.py:112`; token never enters any response — full-read verified). But it has gaps Clauge must NOT copy:

1. **No Host-header check + `Access-Control-Allow-Origin: *`** (`server.py:64,71` — re-verified from a fresh clone 2026-07-17) → DNS-rebinding readable from any website. Clauge already has the right machinery: the **reflecting loopback CORS allowlist** (`server.js:159-264`, `isAllowedReadOrigin` `:211-219`). Decision: add `/v1/*` to `READ_ONLY_API_PATHS` (`server.js:186`) **only if** a browser consumer materializes; curl/node consumers send no Origin and are served regardless (`server.js:212` — and note the CORS middleware only reflects allow-origin headers, it never rejects a request). **Rev-3 reframing — the `/v1` Host check is MANDATORY, not defense-in-depth:** because `/v1` stays out of the CORS allowlist, a DNS-rebinding page (evil.com rebound to 127.0.0.1) issues what the browser considers a *same-origin* request — CORS never engages at all, and the page can read the body. Validating `Host` is `127.0.0.1|localhost(:<port>)` for `/v1/*` is therefore the **primary and only** anti-rebinding control, not a supplement; include a test asserting a `/v1/*` request with `Host: evil.com` is rejected. (One of two independent reviewers argued the check is low-value given the data's low sensitivity; the mechanism above stands regardless, the check is ~5 lines, and Clauge's v1.0.0 security bar favors having it. Note the existing `/api/*` routes lack any Host check and carry the same theoretical exposure — pre-existing, out of scope for this PR.)
2. **Never serve credentials** — trivially satisfied: the sidecar holds no tokens; `usage.json` contains only percentages/timestamps.
3. **No new listener** — same socket, same entitlement, same port discovery.

## 7. Port discovery for consumers (document this in the README when shipping)

External tools find the live port via the port-file the Rust shell already maintains (`src-tauri/src/port_file.rs:10-13,70`; JS mirror `config-paths.js:97`):
- macOS: `~/Library/Caches/Clauge/active-port`
- Windows: `%LOCALAPPDATA%\Clauge\active-port`
- Linux: `$XDG_CACHE_HOME/Clauge/active-port`

Consumer recipe: read port-file → `GET http://127.0.0.1:<port>/v1/usage` → verify `providerId`. (Health probe pattern: `src-tauri/src/port_discovery.rs:59` checks `service == "clauge"`.) Never hardcode 3456 — fallback binding can shift it to 3457–3460.

First consumer, ready today: **ccstatusline's `custom-command` widget** (installed on Adnan's Mac 2026-07-16) can run a 5-line script that reads the port-file and prints e.g. `ROI 3.2x · $4.48 today` into the Claude Code statusline. Ship this script in `docs/` or `scripts/` as the API's demo consumer.

## 8. Config toggle (if the owner wants one)

Default-on is reasonable (the endpoint adds no data beyond existing `/api/usage`). If a toggle is wanted: it MUST live in sidecar-owned `~/.clauge/config.json` via `lib/config-store.js` (atomic tmp+rename, `writeAll` `:138-145`) — **never** in Tauri `settings.json`, which the Rust iCloud loop clobbers every ~300 s (landmine #40, `AGENTS.md:700`). Pattern to copy: `setAlertPrefs` (`config-store.js:183-207`) + a `POST /api/config/...` route like `server.js:711`.

## 9. TDD implementation plan

1. **RED:** `test/server-v1.test.js` — copy the spawn harness from `test/server-additions.test.js` (spawns `node server.js` with `PORT` override + `NO_OPEN=1`, waits for `Listening on`, `:19-29`; honors `CLAUGE_SERVER_BIN` for SEA runs `:8-9`). Assert: 200 array shape, `apiVersion`, line vocabulary, `404`/`204` branches, no-Origin GET allowed. Name tests after the contract rules, not the functions.
2. **RED (pure):** `test/api-v1.test.js` — builder with injected `usageStore`/`store` stubs + fixed clock, modeled on `test/snapshot.test.js`.
3. **GREEN:** implement `lib/api-v1.js`, mount in `server.js`.
4. **Gates (proof-of-done = exact commands + exit codes, unpiped):** `npm run check` (full: validators, fmt, lint, cargo test, node --test) and `npm run test:sea`. CORS decisions verified via `test/cors-allowlist.test.js` pattern if `/v1` is added to the read-allowlist.
5. **Ship:** branch → PR → `gh pr checks --watch` → **per-action merge approval from Adnan**. `main` is protected (required check: `check` on macOS, `enforce_admins: true` — a red check blocks even the owner). Windows `js-tests-windows` is informational, not blocking. (Protection details verified via `gh api` on 2026-07-16; GitHub-side state — re-verify if this doc is old.) **No release tag** in this PR — version-bump lockstep (4 files incl. `Cargo.lock`, landmine #21 `AGENTS.md:391`) happens only on an owner-approved release.

## 10. Dev-loop landmines for the implementing session

- **#31:** release builds SIGKILL hand-run external sidecars; dev-test with `CLAUGE_ALLOW_EXTERNAL=1` + version match, or the AGENTS.md dev loop: `pkill -f clauge && npm run build:sidecar && npm run tauri:dev` (`AGENTS.md:62`).
- **#41:** any endpoint reading session summaries must go through `loadAllSummaries()`'s capped loader (`session-store.js:89-108`, cap 8) — never a parallel unbounded load.
- **#44:** Context7-first for Hono 4 route/sub-app API details before editing (`AGENTS.md:716`).
- **#29:** the 5 local `.cjs` validators are a CI subset — run the full `npm run check`.
- Don't touch: `lib.rs`/`build.rs`/`capabilities/` (no new IPC), `sea-config.json`/`sea-bootstrap.cjs` (no new browser asset), `release.yml` (sign-off-gated, `AGENTS.md:737`).

## 11. Open decisions for Adnan (present before implementing)

1. **Design A (15-line alias) vs B (versioned `lib/api-v1.js` module)?** Recommendation: B.
2. **Wire-format casing** — full camelCase, or aiusage-compatible (`resets_at` in lines)? aiusage-compatible means existing aiusage consumers/dashboards could point at Clauge unchanged; full camelCase is cleaner. Recommendation: aiusage-compatible for `lines[]`, camelCase envelope — maximum interop for near-zero cost.
3. **Config toggle or always-on?** Recommendation: always-on (no new data exposure), add toggle only if requested.
4. **Browser CORS for `/v1`** — include in `READ_ONLY_API_PATHS` now or when a browser consumer appears? Recommendation: defer.
5. **Ship the ccstatusline demo-consumer script** in-repo? Recommendation: yes, `scripts/statusline-consumer.sh` + README section.

## 12. Source references

- aiusage clone dissected at commit `24c6e91` (2026-07-14): key files `src/aiusage/server.py` (ThreadingHTTPServer, TTL cache 300 s, port-as-instance-lock `cli.py:47-55`), `models.py` (schema), `providers/claude.py` (OAuth read + **NO JSONL dedup — the bug Clauge must not import**), `statusline.py` (network-free render path, 1 s timeout), `docs/why.md` (the shared-cache rationale: one daemon polls, every surface reads the cache, render path never touches the network — this is already Clauge's architecture).
- Clauge recon: `main` @ `66b8a5e`, v1.3.3, clean tree, verified 2026-07-16 — and independently re-audited citation-by-citation by a fresh-context reviewer the same day (37+ citations checked, all repo-internal ones correct after the fixes incorporated in this revision). aiusage citations were verified against the clone at `24c6e91` only; they are not re-verifiable from this repo — treat them as point-in-time.
- Verification provenance: this document is revision 2 (fixes applied 2026-07-16 per the adversarial review: port-citation precision, `204`-vs-stale reconciliation, Host-check framing, `src-tauri/` path prefixes).
- **Revision 3 (2026-07-17):** (a) repo citations independently re-verified — 34/34 CONFIRMED, 0 wrong (fresh Opus pass; `buildSnapshot` full range settled as `:276-320`, the companion doc's `:296-319` is the return block only). (b) aiusage citations, previously point-in-time, re-verified from a **fresh clone whose HEAD is still `24c6e91`** — every §3/§6/§12 claim confirmed at the cited lines (schema + None-dropping `models.py:27-29`, error taxonomy `claude.py:52-58`, stale-but-shown `:271-280`, NO requestId dedup anywhere in its JSONL path, wildcard-CORS/no-Host-check `server.py:64,71`, loopback bind `:112`, endpoints `:76-107`, 300 s TTL `:24`, port-as-instance-lock `cli.py:47-55`, `badge` type declared-but-unused, OAuth token used only in the request header — never in any response). (c) §6.1 Host-check reframed MANDATORY per two adversarial design reviews (one dissent noted inline). (d) §4 overage/casing precision fixed.
