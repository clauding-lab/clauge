# Design: Windows Port (Clauge v0.6.0)

**Date:** 2026-05-09
**Author:** brainstorming session
**Status:** approved, ready for implementation plan
**Last reviewed:** 2026-05-15 (see addendum below)
**Target version:** v0.6.0
**Platforms added:** Windows x86_64 (NSIS installer)

---

## Status update (2026-05-15) — design decisions stand, codebase context changed

The design decisions in this document remain valid:

- Dashboard-only on Windows (no tray icon, no popover)
- NSIS installer, `installMode: perUser`, no Authenticode for v0.6.0
- x86_64 only
- Cross-platform Node ESM script for SEA builds
- Unified `latest.json` via mirror-updater CI job
- macOS path untouched

**What changed since 2026-05-09:** four releases shipped on the macOS line
(v0.7.0 through v0.7.3, 2026-05-14 to 2026-05-15) that added Mac-only code
to modules this spec marks as "Unchanged (verified cross-platform)":

| Spec claim | Reality after v0.7.3 |
|---|---|
| `src-tauri/src/ipc.rs` is cross-platform | Now calls into Mac-only `keychain.rs` for `refresh_credentials`, `get_connection_status`, and others |
| `src-tauri/src/port_discovery.rs` is cross-platform | `kill_pid_on_port` shells out to Unix-only `lsof` + `kill -9` (added v0.7.3 for orphan-sidecar self-heal) |
| (Not yet existing in this spec) | New module `src-tauri/src/keychain.rs` uses Apple-only `security-framework` crate |
| (Not yet existing in this spec) | New module `src-tauri/src/keychain_cache.rs` wraps the keychain reader |
| (Not yet existing in this spec) | New module `src-tauri/src/claude_ai_session.rs` uses WKWebView for cookie capture |
| (Not yet existing in this spec) | New module `src-tauri/src/connections.rs` composes the three auth surfaces |

The execution plan at
`docs/superpowers/plans/2026-05-09-windows-implementation-plan.md` has been
updated to add **Phase 7: v0.7.x integration** covering: cross-platform
credential-store abstraction (Mac Keychain ↔ Windows Credential Manager
via the `keyring` crate), cross-platform `kill_pid_on_port` (via
`netstat -ano` + `taskkill /F /PID` on Windows), and verification tasks
for the v0.7.2 first-launch wizard, v0.7.3 cold-launch self-heal, and
Settings → Refresh / Restart Now IPCs.

**New ⚠ empirical-verify gate:** before Phase 7 Task B can be designed
concretely, Task A must execute — install Claude Code CLI on a real
Windows box and verify where `claude /login` persists the OAuth token
(Windows Credential Manager vs `%APPDATA%` JSON vs `%USERPROFILE%\.claude\`).
This is the single highest-information action remaining for the Windows
port.

**Scope changes vs original spec:**

- The "Modifies (cross-platform plumbing)" list grows to include
  `src-tauri/src/keychain.rs` (extracted into `credential_store/macos.rs`)
  and `src-tauri/src/port_discovery.rs` (`kill_pid_on_port` cfg-branched).
- The "Adds (Windows-specific)" list grows to include
  `src-tauri/src/credential_store/windows.rs` and a new `keyring` crate
  dependency in `Cargo.toml`.
- The "Unchanged (verified cross-platform)" list shrinks: `ipc.rs`,
  `connections.rs`, and `port_discovery.rs` are no longer in it. The
  underlying APIs they use are still cross-platform; the call sites
  through `keychain` and `kill_pid_on_port` need cfg-routing.

**Architecture A on Windows is empirically uncertain.** The spec assumes
the Tauri WebviewWindow cookie API works identically on WKWebView (macOS)
and WebView2 (Windows). Phase 7 Task D verifies this; if it doesn't work,
Windows v0.6.0 ships Architecture B (Claude Code keychain) only, with a
documented CHANGELOG limitation.

---

## Problem

Clauge v0.5.0 ships a polished native macOS menu-bar app, but the entire menu-bar
surface (`src-tauri/src/native_popover.rs`, ~671 lines) is built on Apple-only APIs
(`objc2-app-kit`, `objc2-web-kit`, NSPopover, NSStatusItem). Windows users cannot
install or run Clauge today.

A naive port would re-implement the macOS menu-bar metaphor on Windows — system-tray
icon + Tauri WebviewWindow popover. That works, but the macOS UX's killer feature is
the **always-visible % chiclet in the menu bar** (the `update_tray_title` 30s poll in
`native_popover.rs`). Windows tray icons cannot display text labels — only a 16x16 ICO
image. Replicating the % chiclet on Windows requires dynamic ICO rendering every poll,
which is achievable but non-trivial. Without it, a Windows tray icon is just a launcher,
and a launcher is exactly what the Start Menu shortcut already provides.

Therefore the v0.6.0 Windows surface is **the dashboard window only** — opened directly
from Start Menu / Desktop shortcut. No Windows tray icon, no Windows popover. This is
the Spotify / 1Password pattern: menu-bar resident on macOS, normal window app on
Windows. Different platform conventions, same product.

## Decision

Build a Windows NSIS installer that ships the Tauri shell + Hono SEA sidecar. On
Windows, launching the app opens the dashboard immediately. macOS path is
unchanged. Auto-updater works on both platforms via a unified `latest.json`.

Code-signing posture: **ship unsigned for v0.6.0** and accept the Microsoft Defender
SmartScreen warning. Authenticode signing (~$300-500/yr EV cert + HSM/USB token) is
deferred until download volume justifies it.

## Scope

**Adds (Windows-specific):**
- NSIS installer build (`bundle.targets += ["nsis"]`)
- WebView2 download bootstrapper (Tauri's auto-install hook for the renderer)
- `icons/icon.ico` asset
- `scripts/build-sidecar.mjs` cross-platform Node ESM script (replaces bash + `lipo`)
- Windows job in CI matrix (`.github/workflows/release.yml`)
- `mirror-updater` job that merges per-platform `latest.json` files
- Plain-English README section on the SmartScreen install path

**Modifies (cross-platform plumbing):**
- `src-tauri/Cargo.toml`: move `"macos-private-api"` from base `tauri` features to a
  per-target macOS block
- `src-tauri/src/lib.rs`: cfg-gate `mod native_popover;` and its init call; provide a
  Windows setup branch that opens the dashboard on launch
- `src-tauri/src/windows.rs`: cfg-gate the `prevent_close + hide` behavior in
  `create_dashboard`'s window-event handler — Windows lets close proceed naturally
- `src-tauri/tauri.conf.json`:
  - `bundle.targets += ["nsis"]`
  - `bundle.windows.*` block (webviewInstallMode, NSIS config)
  - `beforeBuildCommand` switches from `bash -c '...'` to `node scripts/build-sidecar.mjs`
  - `bundle.icon` includes `icons/icon.ico`

**Removes:**
- `scripts/build-sidecar.sh` (replaced by `.mjs`)

**Unchanged (verified cross-platform):**
- `src-tauri/src/native_popover.rs` — already Apple-only by `[target.'cfg(target_os = "macos")'.dependencies]` gating
- `src-tauri/src/tray.rs` — name is historical; helpers are cross-platform; macOS-specific
  activation policy already gated at line 15-20
- `src-tauri/src/menu.rs` — Tauri's menu API is cross-platform
- `src-tauri/src/sidecar.rs` — pure Node child-process management
- `src-tauri/src/ipc.rs` — Tauri commands, cross-platform
- `src-tauri/src/port_discovery.rs` — TCP probe, cross-platform
- `popover/*` — macOS-only content, ships in SEA blob harmlessly on Windows (served
  but never loaded since there is no Windows popover surface)
- `public/*` — dashboard, cross-platform
- `server.js` + `lib/` — Hono Node.js, cross-platform
- All Tauri plugins (autostart, updater, window-state, notification, store,
  single-instance, shell) — confirmed cross-platform with platform-appropriate
  backends
- Updater minisign signing key + flow — minisign is cross-platform; the `.sig` files
  ride alongside both .dmg and .nsis-setup.exe artifacts

**Out of scope (deliberately):**
- Windows tray icon with dynamic % chiclet — deferred to v0.6.x or later
- Authenticode (Windows code signing) — deferred until download volume justifies cost
- ARM Windows (`aarch64-pc-windows-msvc`) — Surface Pro X / Snapdragon Copilot+,
  <5% market share; defer until there's a user
- MSI bundle (in addition to NSIS) — for corporate IT mass-deployment; defer until
  asked
- Linux — separate surface entirely (libappindicator/StatusNotifier/portal); out of scope

## Architecture

### Module organization

```
src-tauri/src/
├── lib.rs              # cfg-branches setup() between macOS and non-macOS
├── native_popover.rs   # cfg(macos) — gated at module declaration
├── tray.rs             # cross-platform (already is)
├── windows.rs          # cross-platform dashboard; close-behavior cfg-gated
├── menu.rs             # cross-platform Tauri menu
├── sidecar.rs          # cross-platform
├── ipc.rs              # cross-platform
└── port_discovery.rs   # cross-platform
```

### Mental model

| Platform | Surface | Persistence | Launcher |
|---|---|---|---|
| macOS | Menu-bar NSPopover + Tauri dashboard | Always-resident, % chiclet visible | Menu-bar icon |
| Windows | Tauri dashboard only | Quits when window closes | Start Menu / Desktop shortcut |

### Setup flow

`src-tauri/src/lib.rs` setup():

```rust
#[cfg(target_os = "macos")]
{
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    crate::native_popover::init(app.handle())?;
}
#[cfg(not(target_os = "macos"))]
{
    // Windows: dashboard opens on launch and is the only surface.
    crate::tray::show_dashboard(app.handle());
}
```

`mod native_popover;` itself is cfg-gated at the module declaration so the file is
not compiled on Windows.

`Cargo.toml` change:

```toml
# Base tauri features (cross-platform)
tauri = { version = "2.0", features = ["tray-icon", "image-png", "devtools"] }

# macOS-only tauri features
[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "2.0", features = ["macos-private-api"] }
# ...existing objc2-* crates remain here unchanged
```

Note: Cargo unions feature lists across `[dependencies]` and `[target.<cfg>.dependencies]`
blocks for the same crate, so Windows builds compile `tauri` without
`macos-private-api`, which avoids the unsupported-feature warning/error on the Windows
toolchain.

### Window close behavior

`src-tauri/src/windows.rs::create_dashboard` currently always `prevent_close`s and
hides the window on close (so reopens are instant on macOS). On Windows that traps the
user — the close button becomes a no-op since there's no tray icon to relaunch from.

Fix: cfg-gate the prevent-close path to macOS only.

```rust
win.on_window_event(move |event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        #[cfg(target_os = "macos")]
        {
            api.prevent_close();
            let _ = win_handle.hide();
            let _ = app_handle_for_close.set_activation_policy(
                tauri::ActivationPolicy::Accessory);
        }
        // Windows: let the close proceed; Tauri auto-quits when the last window
        // closes; the existing ExitRequested handler in run() drains the sidecar.
    }
});
```

The unused-variable warning on `app_handle_for_close` and `win_handle` for non-macOS
builds is suppressed by `#[allow(unused_variables)]` on the closure or `let _` shadowing
inside the cfg-gated block (fine-tune in implementation).

### Bundle config

`src-tauri/tauri.conf.json` (delta only):

```json
{
  "build": {
    "beforeBuildCommand": "node scripts/build-sidecar.mjs"
  },
  "bundle": {
    "targets": ["app", "dmg", "nsis"],
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" },
      "nsis": {
        "installMode": "perUser",
        "installerIcon": "icons/icon.ico",
        "displayLanguageSelector": false,
        "languages": ["English"]
      }
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

**`webviewInstallMode: downloadBootstrapper` rationale:** Microsoft Edge WebView2
(~150 MB) is the renderer Tauri uses on Windows. Win 11 ships it; Win 10 mostly has it
via Windows Update. For machines without it, this auto-downloads at first launch.
Alternative `embedBootstrapper` baloons the installer; `offlineInstaller` is a heavy
~150 MB blob. `downloadBootstrapper` is the right default for indie unsigned apps.

**`installMode: perUser` rationale:** installs to `%APPDATA%\Local\Programs\Clauge`
instead of `Program Files`. No UAC admin prompt on install or update — critical for an
unsigned app on a corporate machine where users may not have admin rights. Tradeoff:
each Windows user on the machine has their own copy of the app. Acceptable for
single-user developer machines and most bank-employee laptops.

### Cross-platform SEA build script

`scripts/build-sidecar.sh` (bash + `lipo`) is replaced by `scripts/build-sidecar.mjs`
(Node ESM). The .mjs branches on `process.platform`:

- **darwin**: existing logic — fetch arm64 + x64 Node tarballs, run SEA postject for
  each, lipo-merge into a universal binary; output
  `binaries/clauge-server-{aarch64,x86_64}-apple-darwin`
- **win32**: fetch x64 Node Windows .zip, run SEA postject, output
  `binaries/clauge-server-x86_64-pc-windows-msvc.exe`
- **linux**: explicit `console.error` + `process.exit(1)` (out of scope; CI never
  runs on Linux for this project)

`sea-config.json` and `sea-bootstrap.cjs` are platform-agnostic; no changes needed.

`tauri.conf.json` `beforeBuildCommand` switches from
`bash -c 'cd "$(git rev-parse --show-toplevel)" && bash scripts/build-sidecar.sh'`
to plain `node scripts/build-sidecar.mjs`. Cross-platform out of the gate.

`package.json` adds `"build:sidecar": "node scripts/build-sidecar.mjs"` for manual
invocation parity with the old shell script.

### CI matrix

`.github/workflows/release.yml` becomes a build matrix:

```yaml
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { runner: macos-14,       target: universal-apple-darwin, bundles: 'app,dmg' }
          - { runner: windows-latest, target: x86_64-pc-windows-msvc, bundles: 'nsis'    }
    runs-on: ${{ matrix.runner }}
    steps:
      # checkout, node, rust, npm test, cargo test (existing steps)
      # tauri-action with --target ${{ matrix.target }} --bundles ${{ matrix.bundles }}
```

Each matrix job:
- Runs the same JS + Rust unit tests (existing gates)
- Builds its platform's bundle via `tauri-action`
- Uploads artifacts to the same GitHub Release

Existing macOS-specific steps (Stub external binaries, Verify signing secrets) need
small adjustments to be cross-platform — both run on Windows runners just fine, but
the Stub step's `touch` and `chmod` need a Windows equivalent (PowerShell's
`New-Item` + skip chmod since Windows doesn't enforce execute bit).

`fail-fast: false` is intentional: a Windows build failure should not abort an
already-successful macOS build.

### Updater payload merge

Tauri's `tauri-action` emits one `latest.json` per build, each containing only the
platforms that build produced. v0.6.0 needs both platforms in a single `latest.json`
served from gh-pages.

Add a third job that depends on both build matrix entries:

```yaml
mirror-updater:
  needs: build
  runs-on: ubuntu-latest
  steps:
    - Download both latest-{os}.json files from the just-published Release
    - jq-merge their `platforms` keys
    - Commit merged latest.json to gh-pages
```

Each matrix build uploads its `latest.json` as `latest-${{ matrix.runner }}.json`
(or similar), so they don't collide on the Release. The merger job downloads both,
unifies the `platforms` object, writes the result as `latest.json`, and pushes to
gh-pages.

Final `latest.json` shape served from
`https://clauding-lab.github.io/clauge/latest.json`:

```json
{
  "version": "0.6.0",
  "notes": "...",
  "pub_date": "2026-...",
  "platforms": {
    "darwin-aarch64":  { "url": ".../Clauge_0.6.0_aarch64.dmg",          "signature": "..." },
    "darwin-x86_64":   { "url": ".../Clauge_0.6.0_x86_64.dmg",           "signature": "..." },
    "windows-x86_64":  { "url": ".../Clauge_0.6.0_x64-setup.nsis.zip",   "signature": "..." }
  }
}
```

Tauri 2.x's updater client auto-selects the entry matching the user's OS + arch.

The minisign signing key (`~/.clauge-secrets/clauge-update.key`) signs both macOS
DMGs and the Windows NSIS installer. **This is integrity signing, not Authenticode** —
it lets the Tauri updater verify the downloaded artifact was published by the holder
of the private key. SmartScreen still treats the .exe as unrecognized.

### Code signing posture (intentional gap)

For v0.6.0 we ship unsigned (no Authenticode certificate). User experience on
Windows for first-run:

1. **Browser download warning** (Edge/Chrome): "Clauge_0.6.0_x64-setup.exe was
   blocked because it could harm your device." User clicks "Keep anyway" or
   "More info → Keep."
2. **SmartScreen on launch**: "Windows protected your PC. Microsoft Defender
   SmartScreen prevented an unrecognized app from starting." User clicks
   "More info" → "Run anyway."

Both warnings fade as the publisher (us) accumulates download reputation per binary.
For an indie app with low-volume distribution, the warnings can persist for a
significant period.

**README mitigations** (one-time documentation work):
- Screenshot the exact warning dialogs so users know what to expect
- Show the click path: Keep → More info → Run anyway
- Publish a SHA-256 hash of each release binary alongside the GitHub Release notes
- Note that the source is open and the build is reproducible from a tag

### Autostart on Windows

`tauri-plugin-autostart` already supports Windows via the registry key
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. The existing Settings → General
"Launch at login" toggle in `public/app.js::initSettingsGeneralControls()` calls
`plugin:autostart|enable/disable` — these are cross-platform plugin commands. The
implementation should verify on Windows that:
- First-launch auto-enable in `lib.rs:67-86` works (writes to the registry instead
  of macOS Login Items)
- Toggle-off persists across launches
- The `MacosLauncher::LaunchAgent` parameter is ignored on Windows (it is — the
  plugin's Windows backend doesn't read it)

If the parameter causes a build warning on Windows, cfg-gate the plugin init call.
Otherwise leave as-is.

### Windows-specific risks

| Risk | Mitigation |
|---|---|
| WebView2 not installed on user's Windows 10 | `webviewInstallMode: downloadBootstrapper` auto-installs at first launch |
| User runs the .exe but SmartScreen blocks it | Documented warning path in README; SHA-256 hash for verification |
| Auto-updater needs admin on update | `installMode: perUser` puts the install in `%APPDATA%`; no UAC needed |
| GitHub runner SEA build fails (Windows .zip download flakes) | Cross-platform Node script reuses the existing retry pattern from `build-sidecar.sh` |
| `cargo test` Windows-specific failures from macOS-only conditional code | `#[cfg(target_os = "macos")]` gating ensures the macOS code paths aren't compiled on Windows; existing 24/24 cargo tests should remain green on macOS, and the Windows job runs the same cargo test suite to verify cross-platform code paths compile and pass |
| Tauri NSIS bundler missing dependencies on first Windows runner build | Tauri 2.x bundles its own NSIS plugins; pinned version of `tauri-action` should fetch them |
| `popover/*` HTML/JS shipped in the SEA blob but unused on Windows | Acceptable — bytes are <50 KB total, and the SEA single-binary-per-arch convention makes selective exclusion not worth the complexity |

## Testing strategy

**Cross-platform unit tests (existing):**
- `npm test` — JS unit tests run on both runners unchanged
- `cd src-tauri && cargo test --locked` — Rust unit tests run on both runners; new
  cfg-gated branches need their own coverage where possible (most are imperative Tauri
  setup code, hard to unit test)

**Manual smoke (Windows-specific, pre-tag):**
1. Download `Clauge_0.6.0_x64-setup.exe` from the GHA-published Release
2. Confirm SmartScreen warning appears; click "Run anyway"
3. NSIS installer runs; install completes without UAC prompt
4. Start Menu shortcut launches Clauge; dashboard opens; rings render
5. Settings → General toggles persist across relaunch
6. Toggle Launch at login ON; reboot; confirm Clauge auto-launches
7. Close window → app quits cleanly (no orphan `clauge-server.exe` in Task Manager)
8. Trigger a v0.6.0 → v0.6.1 update flow against a test tag; confirm restart + new
   version comes up

**Manual smoke (macOS regression check):**
- All v0.5.0 smokes from `RELEASE_CHECKLIST.md` re-run on `Clauge.app`. The Windows
  port adds Windows surface but should not regress macOS. Particular attention to:
  - NSPopover persists on outside-app click
  - % chiclet updates every 30s
  - Dashboard size 1100×800 on first open (no `~/Library/Application Support/com.clauding.clauge/.window-state.json` interference)
  - Settings → General Launch at login + Updates + About all work

## Decisions made

| # | Decision | Reason |
|---|---|---|
| 1 | Dashboard-only on Windows (Option B) | Without the % chiclet, a Windows tray icon is just a launcher; Start Menu shortcut already provides that. Simpler, ~half the engineering of full parity. |
| 2 | Ship unsigned for v0.6.0 | EV cert is $300-500/yr ongoing + HSM/USB token + CI friction. Defer until download volume justifies. README documents the SmartScreen path for users. |
| 3 | NSIS, not MSI | NSIS for individual users; MSI is for corporate IT mass-deployment. Add MSI later if a bank IT team asks. |
| 4 | x86_64 only, no ARM Windows | Surface Pro X / Snapdragon Copilot+ <5% Windows market share. Add when there's a user. |
| 5 | No Windows tray icon at all | A tray icon without the % chiclet is just another launcher, redundant with the Start Menu shortcut. The chiclet itself is deferred (see "Out of scope"). |
| 6 | Cross-platform Node script for SEA build, not platform-specific bash + PowerShell | Single language, single execution path, reuses existing Node 22 install in CI. |
| 7 | `installMode: perUser` for NSIS | No UAC admin prompt; works on locked-down corporate Windows machines. |
| 8 | Single merged `latest.json` for the auto-updater, built by a third CI job | Tauri 2.x updater consumes one JSON; merging in CI is clean and explicit. |
| 9 | Keep the macOS path entirely untouched | Zero regression risk on the platform that already ships. v0.6.0 is purely additive on Windows. |

## Open questions

- **Windows ARM (aarch64) timing**: stay deferred unless a user pings. Easy to add
  later — same matrix entry, different `--target`.
- **Code-signing trigger threshold**: at what download count does Authenticode become
  worth it? Probably >100 unique installs over a few months. Revisit after v0.6.0
  ships.
- **Linux on the horizon**: not now, but if added later, the cross-platform `.mjs`
  build script and matrix structure are ready. The popover surface there is its own
  design problem (libappindicator vs StatusNotifier vs Wayland portal).

## Definition of done

- [ ] Windows builds succeed on `windows-latest` GHA runner via tagged push
- [ ] Resulting `Clauge_0.6.0_x64-setup.exe` installs without admin
- [ ] Launching from Start Menu opens the dashboard within ~3 seconds (sidecar boot)
- [ ] All Settings → General toggles work on Windows (autostart, updater check, about)
- [ ] Closing the dashboard quits the app and reaps the sidecar process
- [ ] `latest.json` on gh-pages contains entries for `darwin-aarch64`, `darwin-x86_64`,
      and `windows-x86_64` after the v0.6.0 tag is pushed
- [ ] Tauri auto-updater on a v0.6.0 install successfully prompts for and applies a
      v0.6.1 test update
- [ ] macOS v0.5.0 → v0.6.0 auto-update path verified end-to-end (no regression)
- [ ] README documents the Windows install + SmartScreen click-path with screenshots
      and SHA-256
- [ ] `docs/RELEASE_CHECKLIST.md` updated with Windows manual-smoke checklist
