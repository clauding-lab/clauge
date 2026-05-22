# Updater UX Audit — Clauge (Tauri) vs CodexBar (Sparkle)

**Date:** 2026-05-22 (BDT)
**Scope:** Compare Clauge's `tauri-plugin-updater` user-facing flow to CodexBar's Sparkle flow. Surface gaps that should be closed in a follow-up patch release.
**Outcome:** B4 in the CodexBar adoption plan (v0.9.1).

This audit is a paper exercise — gaps are documented, not fixed. Closing them is scoped to a follow-up release (likely v0.9.2 or v0.10.0).

## Current Clauge updater flow

Reverse-engineered from `src-tauri/src/ipc.rs::check_for_updates`, `tauri.conf.json::plugins.updater`, and README's "First launch" section.

1. **App launch / interval check.** Tauri updater hits the endpoint (`https://clauding-lab.github.io/clauge/latest.json`) and parses signature.
2. **Background download.** When an update is found, the new bundle downloads in background.
3. **macOS notification fires.** Title: app name, body: "Update vX.Y.Z is ready."
4. **Settings → Updates pane.** Surfaces the "↻ Restart Now to apply vX.Y.Z" button.
5. **User clicks Restart Now.** App quits, new version replaces the bundle, relaunches.

The UpdateStatus IPC enum has two states: `UpToDate` and `Installed { version }`. There is no "Downloading" or "Failed" surface for the popover/dashboard to observe mid-flight.

## CodexBar / Sparkle flow (reference)

Sparkle is the macOS auto-update standard. CodexBar uses `appcast.xml` (RSS-shaped release feed) + a signed DSA keypair. The user-visible sequence:

1. **Periodic check.** Default 24h.
2. **Update found → modal dialog.** Shows release notes from the appcast (HTML in a small WKWebView), plus three buttons: "Install Update" / "Remind Me Later" / "Skip This Version."
3. **Progress dialog.** Indeterminate spinner → percentage during download → final "Installing..." state.
4. **Install on quit.** New bundle is staged; replaces the app on next quit (or immediately if user clicks "Install and Relaunch").
5. **Failure modal.** Network errors, signature mismatch, disk space issues all surface as specific dialogs.

## Gap analysis

| Element | Sparkle (CodexBar) | Clauge (Tauri) | Gap severity |
|---|---|---|---|
| **Release notes shown to user** | Yes — rendered HTML in modal | No — only version string in notification | **HIGH** — users have no way to know what they're getting before clicking Restart |
| **Skip-this-version action** | Yes — persisted per version | No | MEDIUM — users can't decline specific releases |
| **Remind-me-later action** | Yes — pushes the prompt 24h | No | LOW — users can ignore the notification |
| **Progress UI during download** | Modal with %, bytes/sec | None — silent download | MEDIUM — large updates feel like nothing's happening |
| **Failure modal** | Specific dialogs for network/sig/disk | Logged warning, silent in UI | MEDIUM — failure modes invisible to user |
| **Per-version unique signing key check** | Yes (DSA) | Yes (Tauri keypair, minisign) | None — both secure |
| **Differential / delta updates** | Yes (binary diff) | No — full bundle each time | LOW — adds bandwidth cost but not user-facing |
| **Phased rollout** | Yes (`SUPhasedRolloutInterval`) | No — instant 100% | LOW for solo dev; would matter at scale |
| **Update consent before download** | Yes (modal-first) | No — auto-downloads | MEDIUM — uses bandwidth without asking |

## Findings — prioritized fix list (NOT in v0.9.1)

### F1. Release notes in Settings → Updates pane (HIGH)

Source: `latest.json` already carries a `notes` field per Tauri's spec. The dashboard's Settings → Updates pane has the room to render it as a small scrollable block above the "↻ Restart Now" button.

**Effort:** ~1h. Read `latest.json`'s `notes` field in the IPC layer; render in the pane.

### F2. Update consent before download (MEDIUM)

Tauri's `updater.check()` returns an `Update` value without downloading; download happens on `.download_and_install()`. Today Clauge auto-calls both. A two-step flow:

1. `check_for_updates` returns `UpdateAvailable { version, notes }`.
2. User clicks "Download" in Settings → triggers `download_and_install`.
3. UpdateStatus transitions: `Available → Downloading(pct) → Ready → Restarted`.

**Effort:** ~3h including UI states.

### F3. Failure modal in Settings → Updates pane (MEDIUM)

Today an updater failure logs a warning and the pane shows "Up to date." Worst case the user thinks they're current when they're not. Capture errors in UpdateStatus and surface them as a banner with "Retry" + a "Copy debug info" button.

**Effort:** ~1h.

### F4. Skip-this-version action (MEDIUM)

Persist a "skipped versions" list in the Keychain or `config.json`. Updater check filters out skipped versions when reporting "Available."

**Effort:** ~1h.

## Out of scope for v0.9.1

All four findings (F1-F4) are deferred. v0.9.1 ships with the existing updater flow. Open follow-up issues from this audit before tagging:

- [ ] Issue: "Render release notes in Settings → Updates" (F1)
- [ ] Issue: "Two-step updater: check first, download on consent" (F2)
- [ ] Issue: "Surface updater failures in Settings UI" (F3)
- [ ] Issue: "Skip-this-version action" (F4)

## Recommendation

Land F1 in v0.9.2 (purely UX, low risk). F2 + F3 can ride in v0.10.0 alongside the IAP work since the paywall introduces other Settings-pane changes. F4 is genuinely optional.
