# Design: Native NSPopover Menu Bar (Clauge v0.5.0)

**Date:** 2026-05-09
**Author:** brainstorming session
**Status:** approved, ready for implementation plan

## Problem

Clauge's menu-bar popover (Tauri `WebviewWindow`-based) cannot reliably stay visible
after outside-app clicks while running in `Accessory` activation policy. Twelve+
iterations on macOS NSWindow flag combos (`setHidesOnDeactivate`, `setCanHide`,
`setLevel(NSPopUpMenuWindowLevel)`, `setCollectionBehavior(CanJoinAllSpaces|Stationary)`,
`setAnimationBehavior(None)`, contentView CALayer cornerRadius mask, raw `object_setClass`
to NSPanel, `objc2::define_class!` ClaugePopoverPanel subclass with `canBecomeKeyWindow→false`,
the `tauri-nspanel` plugin, and a flag-based focus-loss re-show handler) all left one of
two failure modes intact:

1. The popover briefly **flickers** (vibrancy + CALayer + WKWebView desync on resignKey
   invalidation) on outside-app focus loss, OR
2. The popover **fully dismisses** on outside-app click (popup-menu auto-dismiss when the
   underlying window is in non-activating-panel mode).

Each fix for one failure mode caused the other. Tauri's `WebviewWindow` abstraction is
the wrong primitive for "menu-bar popover that persists across app deactivation."

## Decision

Replace the Tauri `WebviewWindow`-based popover with a native macOS `NSPopover`
controlled by Rust via raw Cocoa (`objc2-app-kit`). Use `NSPopoverBehavior.applicationDefined`
which never auto-dismisses — show/close is fully under app control. This is the API
Apple designed for the Bartender / iStat Menus / 1Password persistent-popover pattern.

## Scope

**Rebuild from scratch:**
- The macOS menu bar `NSStatusItem` (replaces Tauri's `TrayIconBuilder`)
- The popover host (`NSPopover` + `NSViewController` + `WKWebView`)
- The right-click menu (`NSMenu`)
- Popover ↔ Rust IPC (`WKScriptMessageHandler` instead of Tauri `__TAURI__.core.invoke`)

**Unchanged:**
- Dashboard window (Tauri `WebviewWindow`, working fine)
- Sidecar lifecycle (`sidecar.rs`)
- All current IPC commands in `ipc.rs` (`proxy_fetch`, `open_dashboard`, autostart
  wrappers, `check_for_updates`)
- Activation policy management (`Accessory` ↔ `Regular` based on dashboard state)
- All existing Tauri plugins (single-instance, autostart, updater, notification,
  window-state, store)
- Popover content (`popover/index.html`, `popover/popover.css`) — exactly as-is

## Architecture

### Component split

| Component | Owner | Notes |
|---|---|---|
| Dashboard window | Tauri (`windows.rs::create_dashboard`) | unchanged |
| Sidecar process | Tauri (`sidecar.rs`) | unchanged |
| IPC commands | Tauri (`ipc.rs`) | unchanged |
| Activation policy | Tauri (`lib.rs` + `tray.rs::show_dashboard`) | minor wiring for the new tray module |
| Menu bar `NSStatusItem` | Native (`native_popover.rs`) | replaces Tauri tray |
| Popover host | Native (`NSPopover` + `NSViewController` + `WKWebView`) | new |
| Right-click menu | Native (`NSMenu` attached to status item) | new |
| Popover ↔ Rust IPC | `WKScriptMessageHandler` | new |

### Data flow

1. **App boot.** `lib.rs::run()` setup block calls `crate::native_popover::init(app)`
   instead of the current `crate::tray::init(app)`. The native module:
   - Creates `NSStatusItem` with template icon (loaded from existing `tray-icon.png`)
   - Creates hidden `NSPopover` (`behavior = applicationDefined`,
     `contentSize = (360, 500)` initial, `animates = NO`)
   - Creates `NSViewController` containing a `WKWebView` (size matches popover content)
   - WKWebView loads `http://127.0.0.1:{port}/popover/index.html` (same-origin to /api)
   - Creates right-click `NSMenu` with: Open Dashboard, Preferences…, Check for
     Updates, Quit Clauge
   - Wires `NSStatusItem.button` action handler for left-click → `toggle_popover()`
   - Wires `NSStatusItem.button` right-mouse-down → menu pops up

2. **Left-click tray icon.**
   - If `popover.isShown` → `popover.close()`
   - Else → `popover.show(positioningRect: NSStatusItem.button.bounds, of:
     NSStatusItem.button, preferredEdge: .minY)` (anchors below the icon)

3. **Right-click tray icon.** `NSMenu` pops up; selecting an item dispatches to
   existing handlers (`show_dashboard_with_settings`, `check_for_updates`, `app.exit(0)`).

4. **Popover JS uses native `fetch()`** for `/api/*` calls (same-origin to the SEA
   sidecar, no CORS issue, no `proxy_fetch` indirection). The WKWebView is loaded
   from the SEA, so its origin matches the API.

5. **Popover JS calls Rust** via:
   `window.webkit.messageHandlers.clauge.postMessage({cmd: 'open_dashboard'})`.
   Rust's `WKScriptMessageHandler` receives, dispatches by `cmd` to existing IPC
   logic (`open_dashboard`, `check_for_updates`, etc.).

6. **Rust calls popover JS** via `WKWebView.evaluateJavaScript_` for the few cases
   we need (e.g. forcing a refresh).

7. **% chiclet on tray icon.** Existing 30s tokio interval poll moves from `tray.rs`
   to `native_popover.rs`. Calls `NSStatusItem.button.title = " {pct}%"` instead of
   Tauri's `tray.set_title()`.

8. **Dynamic popover height.** WKWebView measures `#root.offsetHeight` after each
   render; posts `{cmd: 'resize', height: N}` to Rust; Rust calls
   `NSPopover.contentSize = NSMakeSize(360, height)`. Same logic as the current JS
   `resizeToContent()` but routed through native APIs.

## File changes

### New files

- **`src-tauri/src/native_popover.rs`** (~300 lines)
  - `pub fn init(app: &AppHandle) -> Result<()>` — wired in from `lib.rs::setup`
  - `NSStatusItemController` — owns NSStatusItem, click event handling
  - `NSPopoverController` — owns NSPopover + NSViewController + WKWebView
  - `ClaugeScriptHandler` (objc class via `objc2::define_class!`) — implements
    `WKScriptMessageHandler` protocol; receives postMessage from popover JS
  - `NSMenu` setup helper
  - 30s tokio task for tray title polling

### Modified files

- **`src-tauri/src/lib.rs`** — replace `crate::tray::init(app.handle())?` with
  `crate::native_popover::init(app.handle())?` in setup block (~3 lines)
- **`src-tauri/src/tray.rs`** — keep `show_dashboard` and `show_dashboard_with_settings`
  helpers (called from menu handlers + IPC), delete `init`, `toggle_popover`, the
  TrayIconBuilder code (~80 lines deleted, helpers preserved)
- **`src-tauri/src/windows.rs`** — delete `create_popover` (~150 lines) and
  `position_popover_under_tray` (~75 lines). Keep `create_dashboard` unchanged.
- **`popover/popover.js`** — full migration off `__TAURI__`:
  - `invoke('proxy_fetch', {path})` → `fetch(path)` (same-origin, no proxy needed)
  - `invoke('open_dashboard')` → `window.webkit.messageHandlers.clauge.postMessage({cmd: 'open_dashboard'})`
  - `__TAURI__.window.getCurrentWindow().setSize(LogicalSize(...))` → `postMessage({cmd: 'resize', height: N})`
  - Drop the `__TAURI__` detection check entirely; popover only ever runs inside the WKWebView under our control. (Browser-mode degradation isn't needed — the popover is unreachable from a regular browser.)
  - Loading overlay HTML/CSS/JS stays as-is.
- **`server.js`** (SEA sidecar) — add static route for `/popover/*` mapping to the
  bundled popover/ assets (currently SEA only serves `public/`).

### Deleted

- `src-tauri/src/windows.rs::create_popover` and `position_popover_under_tray`
- `src-tauri/src/tray.rs::init`, `toggle_popover`, `show_popover_with_preferences`
- `src-tauri/capabilities/popover.json` (no longer relevant — popover isn't a Tauri window)
- The `popover_user_visible` flag on `AppState` (no longer needed)
- The `show-loading` event listener in `popover.js` (no longer dispatched)
- `tauri-plugin-window-state` filter for popover (no longer a tracked window)

### Cargo deps

- Keep: `objc2`, `objc2-app-kit` (NSPanel/NSWindow/NSResponder/NSView features), `objc2-foundation`, `objc2-quartz-core`
- Add: `objc2-web-kit` for `WKWebView` + `WKScriptMessageHandler` (`features = ["WKWebView", "WKWebViewConfiguration", "WKUserContentController", "WKScriptMessage"]`)
- Drop: nothing critical (tauri tray plugin is part of tauri core, can't drop)

## Error handling

- WKWebView load failure → log; popover shows blank with error overlay (reuse loading.css)
- NSStatusItem creation failure → log error; app continues with degraded experience
  (no menu bar, dashboard still works via dock when in Regular)
- WKScriptMessageHandler postMessage with unknown `cmd` → log warning, no-op
- IPC dispatcher errors (e.g. `open_dashboard` fails) → log warning; popover stays open
- Popover position calculation: NSPopover handles this natively via `positioningRect`

## Testing

- **cargo test** unchanged (24 tests pass currently; native_popover module is mostly
  unit-untestable Cocoa wiring — manual smoke is the verification)
- **Manual smoke test sequence:**
  1. App boots → tray icon appears in menu bar (template icon)
  2. Click tray → popover slides in below icon, content visible
  3. Click on Finder/Safari/another app → **popover stays visible** (the test that
     failed for 12 iterations)
  4. Click tray again → popover dismisses
  5. Right-click tray → NSMenu appears with 4 items
  6. Right-click → Open Dashboard → dashboard window appears
  7. Right-click → Preferences → dashboard switches to Settings tab
  8. Right-click → Check for Updates → status shown
  9. Right-click → Quit → clean exit
  10. After ~30s: tray icon shows ` X%` chiclet
  11. Dashboard "Open" link in popover → dashboard opens via WKScriptMessageHandler

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| NSStatusItem.button is `Optional<NSStatusBarButton>` — could be nil if status bar full | Low | Log + fallback; status bar exhaustion is rare on modern Macs |
| WKWebView in NSPopover needs explicit `wantsLayer = true` and proper sizing | Medium | Use NSViewController auto-resize; verified pattern in Apple docs |
| `WKScriptMessageHandler` retain cycle (handler holds wkwebview holds handler) | Medium | Use `Weak` reference in handler; standard Cocoa pattern |
| SEA sidecar must serve `/popover/*` — currently only serves `/public/*` | Low | Trivial extend in server.js — copy existing static handler |
| Right-click on NSStatusItem.button is non-trivial (need NSEventMonitor or button action mask manipulation) | Medium | Standard pattern: set `button.sendAction(on: [.leftMouseUp, .rightMouseUp])` and dispatch in handler |
| Existing `popover/popover.js` reference to `__TAURI__` will throw if WKWebView doesn't have it | Low | Detection: `if (window.__TAURI__) { ... } else { fetch/postMessage path }`; clean removal once tested |
| Popover dynamic resize via postMessage may flicker briefly on each refresh | Low | Use `NSPopover.animates = NO` to suppress AppKit animation; resize is one-frame |

## Open questions (answered during brainstorming)

| Q | A |
|---|---|
| Persistent popover or standard dismiss? | **Persistent** — like Bartender/iStat |
| Keep popover content (HTML/CSS/JS) or rewrite native? | **Keep** — only the IPC layer changes |
| Keep dashboard as Tauri window? | **Yes** — it works fine |
| Replace Tauri tray entirely or hybrid? | **Replace entirely** — own NSStatusItem in our Rust |
| WKWebView source? | **SEA sidecar HTTP** — same-origin to /api, drops proxy_fetch |

## Estimated effort

~1 day. ~300 lines new Rust (`native_popover.rs`) + ~50-line popover.js diff +
~20-line server.js diff. Most of the time is Cocoa API research + iteration on
WKScriptMessageHandler wiring.

## Out of scope (defer to v0.5.x or later)

- Migration to `tauri-plugin-opener` (deprecation warnings on `tauri-plugin-shell::open`)
- Sidecar `Starting server…` splash for cold-start race
- External clauge-server re-probe
- Dead-code cleanup (`CrashBreaker::was_notified`)
- Updater-on-launch debounce (24h interval)
- Multi-monitor coord-system fine-tuning beyond what v0.4.4 already shipped
