# CodexBar Adoption Plan — Clauge

**Created:** 2026-05-22 (BDT)
**Source of inspiration:** [steipete/CodexBar](https://github.com/steipete/CodexBar) — free MIT Swift menu bar app, 13K stars, ~10 commits/day.
**Branch homes:** Phase A → `main` · Phase B → `clauding-lab/iap-paywall` (when cut) · Phase C → `main` post-v0.10.0.
**Cross-references:** project memory `project_codexbar_competitor.md` · `docs/superpowers/plans/2026-05-19-clauge-iap-paywall-plan.md` (vienna branch — v0.10.0 IAP work).

---

## Scope

Adopt the patterns from CodexBar that fit Clauge's identity (Claude depth + ROI framing) and reject the patterns that would dilute Clauge into a worse CodexBar.

### In scope

- **Process:** consolidated quality gate, strict-mode lint commit gate, Homebrew tap, central release-env config, companion CLI scaffold.
- **Simplicity:** documented rules in `AGENTS.md` (focused tests, sibling-async audit).
- **UI:** popover redesign (CodexBar-style vibrancy + Clauge's circle Session gauge), Anthropic's new `seven_day_design` + `seven_day_routines` fields, Sparkle parity audit.

### Out of scope (deferred or rejected)

| Item | Reason |
|---|---|
| **U1 — Dynamic bar icon with progress fill** | Deferred. High implementation effort (custom NSImage template rendering at multiple fill states) for low daily-glance benefit relative to popover redesign. Revisit if users still want at-a-glance from menu bar after redesign ships. |
| **U4 — Widget Extension (MAS-only)** | Deferred. Requires a separate Tauri target + Swift widget extension. Defer until v0.10.0 IAP is live and the paid tier has a clear adoption signal. |
| **40-provider parity** | Rejected. Dilutes Clauge's Claude-depth identity. CodexBar already owns wide market. |
| **CLI PTY fallback for Claude** | Rejected. CodexBar's 3-path stack (OAuth → CLI PTY → Web) is operational complexity Clauge doesn't need. OAuth + Web cookies is sufficient. |
| **Card-tile popover layout** | Rejected. Earlier proposal; superseded by CodexBar-style vertical scroll. Cards added visual noise that whitespace already solves. |
| **In-popover "Cost" + "Subscription Utilization" sections** | Rejected for the popover. Deeper analysis (the ROI framing) belongs in the dashboard, reached via the "Usage Dashboard" action item. |

---

## Phase A — Process + Simplicity (this week, while v0.9.0 awaits Apple)

Ships to `main` directly. Zero user-visible impact. Each item is a separate small commit, reviewable independently.

### A1. Consolidated `npm run check`

**Files:** `package.json`
**Effort:** ~30 min

Add a single `check` script that bundles format check, lint, type check, and tests:

```json
"check": "cargo fmt --manifest-path src-tauri/Cargo.toml --check && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings && npm test"
```

**Acceptance:** `npm run check` exits 0 on a clean tree; fails fast on any individual gate.

### A2. Strict-mode lint as commit gate

**Files:** new `.github/workflows/check.yml`; optionally a local pre-commit hook.
**Effort:** ~1h
**Depends on:** A1.

CI workflow that runs `npm run check` on every PR + push to main. Warnings become errors via `cargo clippy -D warnings`.

**Acceptance:** Push a commit with a clippy warning → CI fails red. Optionally: local `.git/hooks/pre-commit` runs the same.

### A3. `.mac-release.env` consolidation

**Files:** `.mac-release.env` (gitignored), `.mac-release.env.example` (committed), `docs/RELEASE_CHECKLIST.md` update.
**Effort:** ~1h

Move release-time identifiers — Team ID `CY4FK9S7X9`, Apple ID `adnan_du@yahoo.com`, bundle identifiers, Sparkle URL, ASC App ID `6770303247` — into a single env file. Update release scripts to source from it.

**Acceptance:** Rotating any of these IDs requires editing one file only. Pre-release smoke verifies all envs are sourced before the build runs.

### A4. Homebrew tap setup

**Repo:** new `clauding-lab/homebrew-tap` (separate repo)
**Files in tap:** `Casks/clauge.rb`, `.github/workflows/update.yml`
**Effort:** ~2-3h

Create the tap repo, write a Homebrew cask formula, wire it to auto-update on every Clauge release tag.

Cask outline:

```ruby
cask "clauge" do
  version "0.9.0"
  sha256 "..."
  url "https://github.com/clauding-lab/clauge/releases/download/v#{version}/Clauge_#{version}_universal.dmg"
  name "Clauge"
  desc "Token analytics and subscription ROI for Claude Code"
  homepage "https://github.com/clauding-lab/clauge"
  app "Clauge.app"
  zap trash: [
    "~/Library/Application Support/Clauge",
    "~/Library/Preferences/com.clauding.clauge.plist",
  ]
end
```

**Acceptance:** `brew install --cask clauding-lab/tap/clauge` installs and runs Clauge end-to-end. Listed in main README's Install section.

### A5. Documented rules in `AGENTS.md`

**File:** `AGENTS.md` ("Known landmines" section)
**Effort:** ~15 min

Add two new rules:

- **Focused tests over WebView/Tauri E2E for trial accounting, entitlement state, paywall logic.** Reason: macOS tauri-driver is unsupported (see `docs/RELEASE_CHECKLIST.md` "E2E manual gaps"). Pure-state Rust unit tests cover the same ground without flake.
- **Sibling async tasks (`tokio::join!` / `try_join!`) where one is required and another optional:** ensure the optional one's failure doesn't silently consume the required one's error. Use sequential awaits or a drained `JoinSet` that surfaces required failures and explicitly contains optional failures.

**Acceptance:** AGENTS.md updated + committed. Both rules visible in the "Known landmines" section.

---

## Phase B — Popover redesign + new field fetching (folded into v0.10.0)

Ships on the `clauding-lab/iap-paywall` branch alongside the IAP implementation. Reviewed end-to-end with the paywall work. Starts after v0.9.0 is approved and the IAP branch is cut (Task A0 of the v0.10.0 plan).

### B1. New OAuth field fetching with multi-key fallback

**File:** `src-tauri/src/anthropic_oauth.rs`
**Effort:** ~45 min

Extend the OAuth response deserialization to read two new optional fields with multi-key candidate lists (Anthropic actively renames; CodexBar uses these candidates):

```rust
// Claude Design — candidate keys (try in order, first match wins):
const DESIGN_KEYS: &[&str] = &[
    "seven_day_design",
    "seven_day_claude_design",
    "claude_design",
    "design",
    "seven_day_omelette",
    "omelette",
    "omelette_promotional",
];

// Daily Routines:
const ROUTINES_KEYS: &[&str] = &[
    "seven_day_routines",
    "seven_day_claude_routines",
    "claude_routines",
    "routines",
    "routine",
    "seven_day_cowork",
    "cowork",
];
```

**Schema-drift detection:** if a `seven_day_*` key is present in the response but doesn't match any known candidate, log a warning visible in the dashboard's debug pane so we know Anthropic renamed something.

**Acceptance:** Unit tests cover each candidate key returning the same parsed value. Test fixture with unknown `seven_day_foobar` triggers a logged warning. Existing OAuth tests still pass.

### B2. Server IPC: surface new fields

**Files:** `server.js`, `lib/anthropic-usage.js` (or equivalent route handler)
**Effort:** ~15 min
**Depends on:** B1.

Pass the two new fields through the existing `/api/usage` endpoint to the popover and dashboard. Null when source returns null.

**Acceptance:** Popover receives both fields; both null when not present in upstream response.

### B3. Popover redesign — CodexBar aesthetic + dual-indicator gauges

**Files:** `popover/popover.html`, `popover/popover.css`, `popover/popover.js`, `src-tauri/src/native_popover.rs` (vibrancy material), `src-tauri/tauri.conf.json` (window config if needed).
**Effort:** ~2 days

Implement the locked design. Reference mockup is embedded at the end of this plan ("Locked popover design").

Implementation specs:

- **Surface:** switch popover window to `NSVisualEffectView` material `popover`. Clauge already imports `window-vibrancy`; one-line change in `native_popover.rs`.
- **Width:** 340px (down from 380px).
- **Session circle gauge:** 100px-diameter SVG donut.
  - Track ring: 6px stroke, white at 12% opacity.
  - Fill arc: 6px stroke, Clauge orange `#d97757`, sweeping from 12 o'clock clockwise. Arc length = `usage_percent` × 360°.
  - Needle: 4px white filled circle with 1px drop-shadow, positioned on the outer rim at `time_elapsed_percent` × 360° from 12 o'clock.
  - Center text: `42%` in 28pt SF Pro Display Bold + `Session` in 11pt SF Pro Display Regular below.
  - Overflow tint: if `usage_percent > time_elapsed_percent + 10`, render the over-burn arc segment (the portion past the needle) in muted red `#c97a7a`.
- **All models (weekly) bar:** horizontal 6px bar, 320px wide. Needle (small `▼` glyph 8px above the bar) at time-elapsed position. Fill from left in `#d97757`. Same over-burn rule as the circle gauge.
- **Simple bars** (Sonnet only / Claude Design / Daily Routines): 6px horizontal, no needle. Fill in `#d97757`.
- **Daily Routines special handling:** label is `N of 15 runs today` (count, not percent). Fill = `N / 15`.
- **Extra usage (MTD) overflow rendering:** the fill renders normally up to 100% in orange. Past 100%, the bar extends into red `#c97a7a` for the overage. Absolute percentage shown in the right-aligned label.
- **Balance + auto-reload status:** sub-line under Extra usage. Format: `Balance: $X.XX · Auto-reload {on|off}`. Source: `extra_usage` OAuth field (sub-keys to confirm during B1 — likely `balance` and `auto_reload`). When balance < $5 with auto-reload off, render the balance in red as a soft warning.
- **Stats grid:** 2x2 layout for Today $ / 30d cost / 30d tokens / Latest tokens.
- **Daily spend chart:** vertical bar chart, today highlighted in `#d97757`, history in `#d97757` at ~50% opacity.
- **Top model + disclaimer:** two lines at smaller text, ~80% opacity.
- **Action items:** icon + label per row. "Add Account..." (key icon), "Usage Dashboard" (chart icon), "Status: ..." (lightning icon with state-dependent color).
- **Footer:** Refresh / Settings / About Clauge / Quit with `⌘R`, `⌘,`, `⌘Q` shortcuts shown right-aligned.
- **Section spacing:** 24px between sections; no horizontal divider lines except between action-items and footer.
- **Plan badge:** top-right, after the title. States: "Max (20x)", "Max (5x)", "Pro", "Free Trial Nd", "Grandfathered" (the v0.10.0 grandfather state).

**Removed from popover (relocated to dashboard):** "Cost" expandable section, "Subscription Utilization" / ROI framing. Reached via the existing "Usage Dashboard" action item.

**Acceptance:**
- All sections render with mock data.
- Vibrancy visible against a colorful wallpaper (verify with desert/dune wallpaper for parity with CodexBar's demo).
- Overflow states verified: usage > 100% in Extra usage triggers red; usage > time on Session/Weekly triggers burn-fast tint.
- Daily Routines renders count not percent.
- All existing popover features still work (left-click open, right-click context menu, auto-refresh).

### B4. Sparkle parity audit

**File:** `docs/updater-ux-audit.md` (new)
**Effort:** ~30 min

Compare Tauri updater's user-facing flow (changelog screen, progress bar, restart prompt, error states) to CodexBar's Sparkle UX. Document any gaps.

**Acceptance:** Doc lists findings. Create follow-up GitHub issues for any clear UX gaps that should be fixed in a later patch release.

---

## Phase C — Companion CLI (post-v0.10.0)

### C1. `clauge config` subcommand

**Files:** `lib/cli-config.js` (new), `server.js` (CLI entry detection)
**Effort:** ~4-6h
**Target version:** v0.10.1 or v0.11.0 (post-v0.10.0 ship).

Add a CLI subcommand path: `clauge config <subcommand>`.

Initial subcommands:

- `clauge config get` — print the current Clauge config (Keychain references, sidecar port, plan state).
- `clauge config providers` — list connected providers (for parity with CodexBar's CLI).
- `clauge config enable --provider <name>` / `disable --provider <name>` — toggle data sources (e.g., disable claude.ai cookie scraping).
- `clauge config reset-trial` (dev-mode only — gated by a debug flag) — wipe Keychain trial counter for v0.10.0 sandbox testing.
- `clauge config set-api-key --provider anthropic-admin --stdin` — store an Anthropic Admin API key (for the v0.10.0 / v0.11.0 spend-detail feature).

**Acceptance:** Each subcommand works on a freshly installed Clauge with the SEA sidecar. Documented in README's "CLI" section. CLI mode is invoked when the binary is launched with `clauge config <args>` instead of `clauge` alone.

---

## Sequencing & dependencies

```
Phase A  ──┬── A1 (npm check)            ┐
           ├── A2 (lint gate, needs A1)  │  Independent, this week.
           ├── A3 (release env)          │  Each commits separately to main.
           ├── A4 (Homebrew tap)         │
           └── A5 (AGENTS.md rules)      ┘

Phase B  ──┬── B1 (OAuth fields)         ┐
           ├── B2 (server IPC, needs B1) │  Folded into v0.10.0 branch
           ├── B3 (popover redesign)     │  (clauding-lab/iap-paywall),
           └── B4 (Sparkle audit)        ┘  starts after v0.9.0 ships.

Phase C  ──── C1 (companion CLI)              Post-v0.10.0.
```

**Phase A items are independent and can be done in any order.** Recommended order by leverage:

1. A5 (15 min, AGENTS.md update — pure prose) — quickest win, useful for every subsequent session.
2. A1 (30 min, `npm run check`) — foundation for A2.
3. A2 (1h, CI lint gate) — catches drift starting from the next commit.
4. A3 (1h, release env) — useful when next release happens.
5. A4 (2-3h, Homebrew tap) — visible to users, slightly higher complexity.

---

## Effort summary

| Phase | Items | Effort | Status |
|---|---|---|---|
| A | 5 items | ~5-6h total | Pending |
| B | 4 items | ~3-4 days total | Pending (gated on v0.9.0 + IAP branch) |
| C | 1 item | ~4-6h | Pending (post-v0.10.0) |

**Total active scope:** ~5 days of focused work, spread across two real-time windows (this week for Phase A; alongside v0.10.0 for Phase B).

---

## Locked popover design

This is the canonical reference. Phase B3 implements it.

```
┌──────────────────────────────────────────────┐
│                                              │
│  Clauge                            Max (20x) │
│  Updated just now                            │
│                                              │
│                                              │
│  SESSION                                     │
│                                              │
│                  ●●●●●●●●●●●                 │
│              ●●●               ●●●           │
│            ●●                     ●●         │
│          ●●                         ●●       │
│         ●▼                            ●      │
│         ●            25%              ●      │
│         ●          Session            ●      │
│         ●                             ●      │
│          ●●                         ●●       │
│            ●●                     ●●         │
│              ●●●               ●●●           │
│                  ●●●●●●●●●●●                 │
│                                              │
│  1h 24m of 5h elapsed         Resets in 36m  │
│                                              │
│                                              │
│  All models (weekly)                         │
│                            ▼                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  █████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  12% used                                    │
│  Day 5 of 7 elapsed       Resets Thu 4:59 AM │
│                                              │
│                                              │
│  Sonnet only                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  0% used                  Resets Thu 4:59 AM │
│                                              │
│  Claude Design                               │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  0% used                  Resets Thu 4:59 AM │
│                                              │
│  Daily Routines                              │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  0 of 15 runs today        Resets in 4h 18m  │
│                                              │
│  Extra usage (MTD)                           │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│  █████████████████████████████████████▓▓▓▓   │
│  $19.60 spent / $10 limit          196% used │
│  Balance: $78.63 · Auto-reload off           │
│                                  Resets Jun 1│
│                                              │
│                                              │
│  Today              30d cost                 │
│  $2.40              $187.50                  │
│                                              │
│  30d tokens         Latest tokens            │
│  42.8M              7.1M                     │
│                                              │
│        ▁  ▂ ▃ ▅ █ ▇ ▅ ▃ ▄ ▂ ▁ ▁              │
│                                              │
│  Top model: claude-sonnet-4-6                │
│  Estimated from local Claude logs            │
│                                              │
│  ──────────────────────────────────────      │
│                                              │
│  ⎈  Add Account...                           │
│  ▤  Usage Dashboard                          │
│  ⚡  Status: All systems normal               │
│                                              │
│  ──────────────────────────────────────      │
│                                              │
│  ↻  Refresh                          ⌘R      │
│  ⚙  Settings...                       ⌘,     │
│  ⓘ  About Clauge                             │
│  ✕  Quit                              ⌘Q     │
│                                              │
└──────────────────────────────────────────────┘
```

### Key design decisions captured in this mockup

1. **Session = circle gauge.** Preserves Clauge's signature visual; secondary metrics are bars to match CodexBar's spacious rhythm.
2. **Dual indicator on Session + All models.** Fill = resource consumed; needle = time elapsed in the window. The relationship between them tells the burn-rate story — Clauge's actual ROI signal, which CodexBar doesn't surface.
3. **Sonnet only / Claude Design / Daily Routines are simple bars.** No needles. Match CodexBar's lower-section rhythm.
4. **Daily Routines uses count, not percent.** Anthropic exposes 15/day cap.
5. **Extra usage can overflow into red.** Matches claude.ai's own visualization for over-cap spend.
6. **Balance + auto-reload status surfaced inline.** Critical context that softens an alarming "196% used" — user instantly sees runway and whether auto-reload protects continuity. Red soft-warning when balance is low and auto-reload is off.
7. **No in-popover Cost or Subscription Utilization sections.** Deep ROI analysis lives in the dashboard. Popover is glanceable only.
8. **Vibrancy is required.** Match CodexBar's translucent feel; rejects the current dark solid-background look.

---

## Out-of-scope reminder

This plan does **not** include the v0.10.0 IAP paywall implementation. That work is in `docs/superpowers/plans/2026-05-19-clauge-iap-paywall-plan.md` (vienna branch, will be cherry-picked to `clauding-lab/iap-paywall` per Task A0 of that plan when v0.9.0 ships). Phase B of this plan rides on the same branch but is logically separate.
