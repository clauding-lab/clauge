# Vision

Clauge is the menu-bar control surface for Claude Code + claude.ai usage and subscription ROI. It should keep adding small, glanceable insight while preserving fast launches, privacy-first local data handling, and a single coherent native experience across macOS (DMG + MAS) and Windows (NSIS).

The rules below scope what AI agents and contributors can ship without explicit sign-off.

## Merge by Default

- Bug fixes with clear cause and bounded blast radius.
- Documentation, README, CHANGELOG (pending-release section only), and code-comment fixes.
- Small UI/UX tweaks that don't change layout, copy, or behavior materially.
- New tests, including coverage for existing code.
- Logging additions and small observability improvements.
- Extensions to existing parser/aggregator patterns when they follow the established shape (e.g., a new field on an existing JSON response).
- Internal refactors confined to a single module that don't change the external surface (IPC signatures, public types, exported functions) and keep tests green.
- Dependency patch-version bumps (`^1.2.3` → `^1.2.4`) — *except* Tauri, tauri-plugin-*, reqwest, serde, tokio.

## Needs Sign-Off

- **New features** — any change to user-visible behavior beyond a bug fix.
- **Dependency additions** in `package.json` or `Cargo.toml`.
- **Dependency minor or major bumps**, and any bump (patch included) of: Tauri core, any `tauri-plugin-*`, `reqwest`, `serde`, `tokio`.
- **Toolchain / Node / Rust MSRV changes.**
- **Broad refactors** that span >1 module or touch the IPC boundary.
- **Architectural changes** — new dirs at repo root, new build steps, new long-running processes.
- **Release pipeline edits** — `.github/workflows/release.yml`, signing, updater endpoint, appcast format, `gh-pages` content, `latest.json` schema.
- **Tauri config changes** — `tauri.conf.json`, `tauri.mas.conf.json`, `capabilities/main.json` permission grants (outside of routine new-command additions), `entitlements.dmg.plist`.
- **Keychain semantics or item-name changes** — both `Claude Code-credentials` and `com.clauding.clauge.claude-ai-session` are load-bearing.
- **Paywall / IAP / entitlement logic** once v0.10.0 lands.
- **First-launch wizard flow changes** (steps, copy, ordering).
- **Tray icon redesign** — backlog item; needs monochrome SVG authored first.
- **Privacy-impacting changes** — telemetry, network destinations, data storage locations, log content that could leak user data.
- **Apple Developer / Team ID / signing identity changes.**
- **Anything that requires editing CHANGELOG.md historical entries.**

## When in doubt

If a change could conceivably surprise the user, ask first. Cost of one extra question << cost of one bad surprise.
