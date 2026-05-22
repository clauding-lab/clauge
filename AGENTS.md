# AGENTS.md — Clauge

Operational rules for AI coding agents (Claude Code, Cursor, Codex CLI, etc.) working in this repo. Read this in full before making any code change.

## What Clauge is

Clauge = **Claude + Gauge**. A token-analytics + subscription-ROI tracker for Claude Code and claude.ai. Ships as:

- **V3 native app** (Tauri 2) — universal macOS DMG, macOS App Store (MAS) build, Windows NSIS installer. This is the product.
- **V2 npm CLI** — legacy `npx clauge` entry; same `server.js` Hono server runs embedded inside V3 as a Node-SEA sidecar. The npm package is retained but not the primary install path.
- **Clauge Sync** — Chrome extension (`extension/`) that scrapes claude.ai usage and POSTs it to the local server. Optional but recommended.

Owner: solo dev (Adnan, Bangladesh, UTC+6). Vibe-coded — Adnan directs AI agents, does not hand-write code himself. All explanations, summaries, and prose should be in **plain English with technical terms briefly explained**, never assume Adnan reads code.

## Repository structure

```
src-tauri/                  # Tauri 2 native shell (Rust)
  src/
    lib.rs                  # Tauri builder + invoke_handler! macro
    main.rs                 # entry point
    ipc.rs                  # all #[tauri::command] handlers
    tray.rs, menu.rs, windows.rs, native_popover.rs
    sidecar.rs              # SEA sidecar lifecycle (spawn/health/evict)
    anthropic_oauth.rs      # Keychain item "Claude Code-credentials"
    claude_ai_session.rs    # Keychain item "com.clauding.clauge.claude-ai-session"
    keychain.rs, keychain_cache.rs, port_discovery.rs, connections.rs
  build.rs                  # APP_COMMANDS allowlist for tauri-build
  capabilities/main.json    # IPC permission grants per command
  tauri.conf.json           # bundle/signing/updater config
  entitlements.dmg.plist    # macOS entitlements for DMG flavor
server.js                   # Hono server (Node SEA inside V3, or standalone via npm)
lib/                        # server.js modules (aggregator, parsers, routes)
scripts/                    # build-sidecar.mjs, sea-config.json, sea-bootstrap.cjs
public/                     # Dashboard SPA (V2.2)
popover/                    # Menu-bar popover SPA (V3 only)
extension/                  # Chrome MV3 extension "Clauge Sync"
test/                       # node --test suites; e2e/ uses tsx + webdriverio
docs/                       # RELEASE_CHECKLIST.md, PRIVACY.md, CWS_LISTING.md, superpowers/
.github/workflows/release.yml  # tag-driven release pipeline
```

## Build, Test, Run

| Goal | Command |
|---|---|
| Run server only (dev) | `npm run dev` |
| Run native app (dev) | `npm run tauri:dev` |
| Build sidecar (Node SEA) | `npm run build:sidecar` |
| Build native app (release) | `npm run tauri:build` |
| Unit tests | `npm run test` |
| SEA smoke test | `npm run test:sea` |
| E2E (Linux/Windows only) | `npm run test:e2e` — **does not work on macOS**, tauri-driver lacks macOS support |
| macOS pre-tag smoke | Manual; see `docs/RELEASE_CHECKLIST.md` |

`cargo tauri dev` runs Tauri's own dev loop but **does NOT run npm's prebuild scripts** — so changes to the sidecar (`scripts/build-sidecar.mjs`) won't be picked up. Always run `npm run build:sidecar` before `cargo tauri dev` after sidecar changes.

## Release flow

Tag-driven. `git tag v0.X.Y && git push origin v0.X.Y` triggers `.github/workflows/release.yml` which:

1. Runs `npm run test` gate.
2. Builds Universal (arm64 + x86_64) DMG with Tauri-keypair-signed updater payload.
3. Publishes a non-draft GitHub Release with the .dmg + .app.tar.gz + .app.tar.gz.sig.
4. Mirrors `latest.json` to the `gh-pages` branch — updater endpoint reads from `https://clauding-lab.github.io/clauge/latest.json`.

**Before tagging:** complete the macOS smoke + Windows smoke in `docs/RELEASE_CHECKLIST.md`. Pre-fill `CHANGELOG.md`.

**MAS build:** uses a separate `tauri.mas.conf.json` (lives on the `mas-implement-session` branch, not main). Don't merge or rebase that branch into main without explicit sign-off — it contains signing IDs and provisioning profile paths that are environment-specific.

## Coding style

- **Rust:** `cargo fmt` + `cargo clippy --all-targets --all-features -- -D warnings`. Edition 2021, MSRV 1.77.2.
- **JS/TS:** node:test for unit tests; no lint config committed yet — match existing style. Prefer ESM (`type: "module"`).
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, etc.) with optional scope. Imperative mood. **No `Co-Authored-By: Claude` lines** — attribution is disabled globally; do not re-add.
- **Files:** keep modules focused; ~400 lines typical, 800 max. Split Rust modules when one starts mixing tray + popover + keychain logic.

## Known landmines (read before touching these areas)

### 1. Tauri 2 IPC needs registration in THREE places

Adding a new `#[tauri::command]` requires updating:

1. `src-tauri/src/lib.rs` — register in the `invoke_handler!` macro.
2. `src-tauri/build.rs` — add to the `APP_COMMANDS` allowlist (tauri-build reads this).
3. `src-tauri/capabilities/main.json` — add to the `permissions` array.

Missing any one of the three = silent IPC rejection from JS with no useful error. The browser console may show `Command "foo" not allowed` or just hang.

### 2. SEA sidecar has TWO asset manifests — keep them in sync

The Node SEA (Single Executable Application) bootstrapper has two parallel asset lists:

1. `scripts/sea-config.json` — Node's official SEA manifest.
2. `scripts/sea-bootstrap.cjs` — the `ASSETS` array used at runtime.

Adding a file to `public/` alone yields a silent 404 at runtime. To add a new asset:

1. Drop the file in `public/`.
2. Add the path to **both** sea-config.json AND sea-bootstrap.cjs `ASSETS`.
3. Re-run `npm run build:sidecar`.

`cargo tauri dev` does NOT re-run the sidecar build — manually rebuild when sidecar code/assets change.

### 3. Tauri 2 platform-specific webview URLs

The Tauri webview URL differs by platform:

- **macOS:** `tauri://localhost/`
- **Windows:** `http://tauri.localhost/`

Any `on_navigation` handler, CORS allowlist, or string equality check on the webview origin **must allow both shapes** or Windows webview will fall to `about:blank` with no error.

### 4. Keychain item naming (do not rename)

Two keychain items, both load-bearing:

- `Claude Code-credentials` — Claude Code's own OAuth token, written by Anthropic's CLI. Clauge reads-only.
- `com.clauding.clauge.claude-ai-session` — Clauge's own claude.ai session cookies (written by Clauge Sync extension via the local server).

Renaming either breaks the v0.10.0 grandfather-detection logic (planned for `clauding-lab/iap-paywall` branch).

### 5. macOSPrivateApi must be declared at the base level of Cargo.toml

`tauri-build`'s allowlist check walks `[dependencies]` only — not per-target blocks. The `macos-private-api` feature must be on the base `tauri = { ... }` line, not gated by `cfg(target_os = "macos")`. Tauri's own internal cfg-gates handle the actual macOS-only usage; declaring the feature on non-Apple targets is harmless.

### 6. Subagent dispatches always use Opus

Every `Agent` tool call in this repo uses `model: "opus"` — no exceptions, regardless of task size or skill guidance. Adnan's standing rule.

### 7. Tray icon is currently NOT a template image

`src-tauri/icons/tray-icon.png` is a downscaled colored render of the 1024×1024 app icon. macOS expects template images (flat black-on-transparent) for proper tinting in light/dark menu bars. This is on the backlog (see `docs/RELEASE_CHECKLIST.md` "Known issues"). Don't "fix" it without coordinating — a true monochrome SVG variant needs to be authored first.

### 8. Apple Developer + MAS context

- Team ID: `CY4FK9S7X9`
- Apple Developer account: `adnan_du@yahoo.com` (NOT the primary `adnan.rshd@gmail.com`)
- Account active through 2027-05-17
- App Store ID: `6770303247`
- MAS bundle ID: `com.clauding.clauge`
- Provider short name lives in `tauri.mas.conf.json::providerShortName` (mas-implement-session branch only)

### 9. Prefer focused unit tests over WebView/Tauri E2E for trial, entitlement, and paywall logic

macOS `tauri-driver` is unsupported (see `docs/RELEASE_CHECKLIST.md` "E2E manual gaps" — tauri-driver v2.0.6 supports Linux and Windows only). Live AppKit/menu/popover E2E tests on macOS therefore can't run. For trial accounting (v0.10.0), entitlement state, and paywall logic, write pure-state Rust unit tests against the underlying functions — they cover the same behavior without the flake. Extract pure functions from Tauri commands when needed.

### 10. Sibling async tasks where one is required and another optional

When running two async tasks in parallel (`tokio::join!`, `try_join!`, `JoinSet`) and one is required-to-succeed while the other is best-effort, ensure the optional one's failure cannot silently consume or cancel the required one's error. Prefer sequential awaits, or a drained `JoinSet` that surfaces required failures and explicitly contains optional failures. If you see stack traces mentioning premature cancellation in a parallel task block, audit nearby parallel-task usage.

## Communication & timezone

- **All times in BDT (UTC+6).** When generating timestamps, dates, or schedules, convert to BDT and label it.
- **Plain-English explanations** of technical terms in conversation, even obvious ones (e.g., "Keychain — macOS's encrypted credential store"). Adnan reads but doesn't write code.
- **No emojis** in code or commits unless explicitly requested.
- **Short, scannable updates** — Adnan reads on mobile often.

## Out-of-scope behaviors

Do not, without explicit user sign-off:

- Modify `.github/workflows/release.yml` — tag-driven, sensitive.
- Modify `src-tauri/tauri.conf.json` updater section, bundle identifier, or signing config.
- Touch `src-tauri/capabilities/main.json` permissions list outside of new-command additions (see landmine 1).
- Modify CHANGELOG.md historical entries.
- Add new dependencies to `package.json` or `Cargo.toml`.
- Run `git push origin v*` (tag pushes trigger releases).
- Run `git push --force` against any branch.

For everything else, see `VISION.md` for what auto-merges vs needs sign-off.

## Cross-cutting rules

Adnan's global rules live in `~/.claude/CLAUDE.md` (loaded automatically by Claude Code). When that file conflicts with this one, this file wins because it's project-specific.
