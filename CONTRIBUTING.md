# Contributing to Clauge

Thanks for thinking about contributing. Clauge is a small project — most patches land within a day or two if they pass the checks below.

## Before you open a PR

1. **Read [`AGENTS.md`](AGENTS.md) "Known landmines".** Sections #1-#15 enumerate the non-obvious gotchas that bite first-time contributors (Tauri IPC triple-registration, SEA manifest mirror, Tauri 2 platform-specific URLs, Keychain item names, etc.). Skim it, then come back.
2. **Make sure `npm run check` is green.** That's the same gate CI enforces:
   ```bash
   npm run check
   ```
   Which is shorthand for:
   - `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
   - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
   - `cargo test --manifest-path src-tauri/Cargo.toml --quiet`
   - `node --test test/*.test.js test/cli/*.test.js`
3. **Add tests for new behavior.** TDD is preferred for non-trivial logic. Unit-test files live under `test/` (lib/server tests) and `test/cli/` (CLI subcommand tests). Pure functions are easier to test — extract them where it helps.
4. **Update [`CHANGELOG.md`](CHANGELOG.md)** in the `## [Unreleased]` section (or open one if it's missing). Format: bullet under `### Added` / `### Fixed` / `### Changed`. Skip noise (formatting, dependency bumps) unless they affect users.

## Commit message style

Conventional Commits:

```
<type>(<scope>): <subject>

<body — wrap at 72 cols, explain *why* not *what*>
```

- **Types:** `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`.
- **Scope:** optional but encouraged (e.g., `feat(activity):`, `fix(dashboard):`).
- **Subject:** imperative mood ("add X", not "added X"). Under 72 chars.
- **Body:** what changed and why; what alternatives were considered; any
  known trade-offs. Cross-reference issues with `Closes #123`.

**No `Co-Authored-By: Claude` attribution lines.** Clauge is built with heavy AI assistance, but attribution is intentionally disabled globally. Don't re-add. (Configured in `~/.claude/settings.json` if you're running Claude Code locally.)

## Where to file issues

- **Bugs:** <https://github.com/clauding-lab/clauge/issues/new>. Include Clauge version, OS, and reproduction steps. Logs from the dashboard's
  About panel help.
- **Feature requests:** open an issue with the `enhancement` label. Read the
  [`README.md`](README.md) "What's coming" section first — some ideas are
  already scoped for the next release.
- **Security:** see [`SECURITY.md`](SECURITY.md). Do **not** file a public
  issue for anything that looks like a vulnerability.

## Issue-response cadence

We aim to acknowledge issues within **48 hours**, even if the acknowledgement
is just "got it, looking". Bugs that block install (the DMG won't open, the
sidecar won't bind, the wizard loops) or break core functionality (cost math
wildly wrong, dashboard 100% blank for everyone) get **same-day attention**.

Feature requests and lower-severity bugs may sit longer if a release is mid-
ship — we'll triage them as soon as the in-flight branch lands. If a week goes
by without a response, ping the issue thread — sometimes notifications fall
through.

## Project structure

```
.
├── server.js                — Hono server (also the SEA entrypoint + CLI binary)
├── lib/                     — pure JS modules (parser, aggregator, store, CLI)
├── test/                    — node:test files for lib + server
│   └── cli/                 — CLI subcommand tests
├── popover/                 — source of truth for popover assets
│   ├── popover.js
│   ├── popover.css
│   ├── heatmap.js           — shared with dashboard
│   ├── heatmap.css          — shared with dashboard
│   └── index.html
├── public/                  — dashboard static assets
│   └── popover/             — auto-copied from `popover/` at build time
├── extension/               — Chrome extension (Clauge Sync)
├── src-tauri/               — Tauri 2 shell (Rust)
│   └── src/
│       ├── lib.rs
│       ├── ipc.rs
│       ├── windows.rs
│       └── native_popover.rs
├── scripts/                 — build + validation scripts
└── docs/                    — release checklists, plans, handoffs
```

Source-of-truth for popover assets is `popover/`. `build-sidecar.mjs` copies them into `public/popover/` at build time; `public/popover/` is `.gitignore`d. Don't edit `public/popover/*` directly — your edits will be overwritten.

## What needs sign-off

Per [`VISION.md`](VISION.md), some changes need explicit Adnan sign-off before merge:

- **Release pipeline edits** (`.github/workflows/release.yml`, signing config).
- **Bumping major Tauri / wry / Hono versions.**
- **Adding new dependencies** to `package.json` or `Cargo.toml` outside the
  established stack.
- **Changes to OAuth credential paths** or Keychain item names.

A draft PR is the cleanest way to start that conversation.

## License

By contributing, you agree your contributions are licensed under the MIT License (see [`LICENSE`](LICENSE)).
