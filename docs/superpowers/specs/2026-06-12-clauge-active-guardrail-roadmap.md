# Clauge — Active-Guardrail Wave: Roadmap & Architecture Decisions

**Date:** 2026-06-12
**Status:** Decisions locked in a brainstorm session (post-v1.2.0). This is a **decomposition/roadmap** doc, not a single feature spec — each sub-project below gets its own spec → plan → build cycle.
**Repos:** `clauge` (desktop: Mac + Windows) + `clauge-ios`.

---

## Context

v1.2.0 shipped (stability + iCloud sync-health; DMG live, MAS build 8 in review). The next wave turns Clauge from a *passive dashboard* into an *active guardrail*: it should **forecast and warn**, not just display. This doc records the architecture decided for that wave — and the Windows↔iOS transport problem it surfaced along the way.

---

## Locked decisions

### Projection (the foundation)

- **On-device, per platform** — NOT computed on the Mac and shipped in the snapshot. Each app forecasts from the usage data it *already has*, so no user is stranded without a Mac. **Two implementations:** the **desktop Node sidecar** (covers Mac AND Windows from one codebase) + **iOS Swift**. Specify the algorithm once with **shared test vectors**; implement natively on each side.
- **Three projection types — all in scope:**
  - **(a) within-window linear** — "at this rate you hit your 5-hour limit ~3pm / weekly ~Thursday." Uses only the current window's % + time-left + recent rate. **No history needed → universal.**
  - **(b) trend-based** — uses accumulated local history ("this week's pace is +15% vs last week"). Richer; must **degrade gracefully to (a)** when history is sparse.
  - **(c) ROI pace** — "on track for 22× this month." Needs Claude-Code spend.
- **Reach (who gets what, and how):**
  - **a, b → every surface** (desktop + iOS), from each app's own usage. Universal.
  - **c → desktop (Mac + Windows)** from local spend, and **Mac-paired iPhone** via the iCloud snapshot. **Not** on a Mac-less iPhone (no spend source exists — inherent, identical to how today's Analytics tab is already Mac-gated).

### Alerts + tray (the active part)

- **Desktop alerts + tray options** (renamed from "Mac menu-bar") — Tauri's notification + tray-icon APIs are cross-platform, so this covers **Mac AND Windows** (macOS menu-bar / Windows system tray). The config UI lives in the dashboard webview (cross-platform). Fires local notifications on thresholds (e.g., 80% of a window, ROI < 1×) and forecast events.
- **iOS alerts** — genuinely constrained: Apple blocks reliable background polling and Clauge has **no push server (by design)**. Realistic scope = **scheduled local notifications** computed from predicted threshold/reset times *while the app is foregrounded*. Best-effort, not real-time. Designed separately; lowest certainty.

### Windows ↔ iOS transport

- The Mac↔iPhone bridge rides **iCloud** (Apple-only). A Windows app can't write the app-container iCloud, so **Windows has no native cross-device path to the iPhone**.
- **Transport abstraction (repository pattern):** one `SnapshotTransport` interface (`publish(bytes)` / `read()`) with swappable implementations, **one active at a time** → a single source of truth at runtime, and everything upstream (projection, analytics, UI) stays **transport-blind**.
- **Per-platform transport:** Mac → **iCloud** (zero-config default). Windows → **Google Drive** (for anywhere-access), behind the same interface. The user/platform selects one; nothing upstream branches on it.
- **GDrive is FEASIBILITY-GATED.** Run a **Google-Drive-specific feasibility spike FIRST**; **if it's a no-go, fall back to LAN-based pull only for Windows** (same-network, cloud-free — reuses the sidecar's existing HTTP `/api/snapshot`, gated by a pairing token).
- **QR / short-code pairing** is the on-ramp for the non-iCloud transports (carries the Drive folder reference, or the LAN address + token). iCloud needs no pairing (container is implicit by app identity).
- **No hosted backend / relay** — preserve the serverless, on-device, no-accounts ethos. That's why the cloud option is the user's **own** Google Drive (not a relay we run), and why it's gated by a cloud-free LAN fallback.
- **Honest cost:** Google Drive reintroduces an **OAuth login on *both* desktop and iPhone** — the accounts-friction now reaches iOS for Windows-paired users. The population it serves (Windows-desktop users who *also* run the iPhone app *and* want Code-analytics on the phone) is a niche-of-a-niche; weigh the subsystem cost against "Windows is standalone; pair a Mac for phone analytics."

### Friction debt (independent maintenance)

- **Notarization** (Mac) — removes the Gatekeeper right-click→Open friction. Needs a Developer-ID **Application** cert (≠ the MAS cert) + ~6 CI secrets. Deferred 4×. Ready-made YAML in `docs/superpowers/plans/2026-05-26-v0.10.0-onboarding-plan.md` Phase 1 (note its stale `matrix.platform` gate → use `if: runner.os == 'macOS'`).
- **Plan-tier auto-detect** — auto-fill the ROI cost field from the keychain plan tier instead of typing "$200." Spec on disk: `docs/superpowers/specs/2026-05-30-plan-tier-autodetect-design.md`.
- **Sync-health staleness fix** — close the v1.2.0 gap where a *silent* no-error iCloud stall doesn't escalate (the primary error-bearing wedge is already caught). Stamp a "last confirmed upload" time and derive staleness from it, not from tick-start.

---

## Sub-project decomposition + sequence

| # | Sub-project | Platforms | Notes |
|---|---|---|---|
| **A** | On-device projection (a/b/c) | desktop sidecar + iOS | **Foundation**; unblocks alerts. Build first. **Amended 2026-06-12:** A ships **desktop-first** (spec: `2026-06-12-on-device-projection-design.md`); the iOS implementation is re-homed to the C/T cycle, consuming the shared test vectors. |
| **B** | Desktop alerts + tray options | Mac + Windows | Builds on A; relatively contained. |
| **C** | iOS alerts (scheduled-local) | iOS | Constrained; design separately; lowest certainty. |
| **T** | Windows↔iOS transport | Windows + iOS (+ Mac refactor) | Transport abstraction + **GDrive spike → GDrive _or_ LAN-pull fallback** + QR pairing. Independent; the spike can start anytime. |
| **D** | Friction debt | Mac (mostly) | Notarization + plan-tier auto-detect + staleness fix. A quick parallel "polish" release. |

**Recommended order:** **A → B**, with **T** (starting with the GDrive spike) and **D** runnable in parallel/independently. **C** last.

---

## Open feasibility questions (resolve before committing the relevant sub-project)

- **GDrive spike (decides T's path):** can one `drive.file` app-folder, *written by the Windows app*, be *read by the iOS app* under the **same** Google account + **same** Cloud project? What's the OAuth verification burden for the scope? Token refresh on both platforms? Read latency / acceptable polling cadence? → **no-go ⇒ LAN-pull-only fallback for Windows.**
- **LAN-pull specifics:** the sidecar binds **localhost-only today** (the S2 CORS lock) — LAN pull requires binding to the network **and** token-gating it (a deliberate security design, not a flip). Plus iOS's "find devices on your local network" permission prompt + **mDNS** so a changing DHCP IP doesn't break a pairing.
- **Projection (b) history density on iOS** — sparse if the app is opened rarely; (b) must degrade gracefully to (a).
- **Windows app maturity** — historically under-tested (rescoped + deferred); budget a **Windows smoke pass** for any sub-project that ships there (A, B, T).

---

## Next step

Pick a sub-project — recommended **A (on-device projection)** — and run it through its own brainstorm → spec → plan → build cycle in a **fresh session** (this brainstorm is deep into its context budget). The **GDrive spike** under T can run independently whenever.
