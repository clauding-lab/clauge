# Native NSPopover Menu Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clauge's Tauri `WebviewWindow`-based popover with a native macOS `NSPopover` (`behavior = applicationDefined`) controlled by raw Cocoa from Rust, so the popover persists across outside-app clicks like Bartender / iStat Menus.

**Architecture:** Tauri keeps the dashboard window, sidecar lifecycle, IPC commands, and all current plugins. A new Rust module (`native_popover.rs`) owns the macOS menu bar entirely: `NSStatusItem` (replaces Tauri's tray), `NSPopover` (hosts a `WKWebView` loading the existing popover HTML from the SEA sidecar), `WKScriptMessageHandler` (popover-JS-to-Rust IPC bridge), and `NSMenu` (right-click). The popover content (`popover/index.html`, `popover.css`) is reused as-is; only `popover.js`'s IPC layer is rewritten.

**Tech Stack:** Rust 1.95 stable, Tauri 2.11.1, objc2 0.6, objc2-app-kit 0.3, **objc2-web-kit 0.3 (NEW)**, objc2-quartz-core 0.3, objc2-foundation 0.3, Node 22 SEA sidecar (Hono-based, serves popover/dashboard HTTP).

**Spec:** [`docs/superpowers/specs/2026-05-09-native-nspopover-menubar-design.md`](../specs/2026-05-09-native-nspopover-menubar-design.md)

**Conventions:**
- Minimal comments — only on non-obvious WHY (per CLAUDE.md)
- Mutex pattern: `.lock().ok().and_then(...)` (no `.unwrap()`)
- macOS-only code wrapped in `#[cfg(target_os = "macos")]`
- House style for objc2: typed bindings preferred, raw `msg_send!` only when binding missing
- Per-action approval for shared-state writes (commit, push, tag) — DO NOT push without explicit user approval
- Tests must stay green: cargo 24/24, npm 109/109

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src-tauri/Cargo.toml` | Modify | Add `objc2-web-kit` dep with WKWebView features |
| `src-tauri/src/native_popover.rs` | **Create** | NSStatusItem + NSPopover + WKWebView + WKScriptMessageHandler + 30s tray-title poll. ~300 lines. Single module — components tightly coupled, splitting would add indirection without clarity gain. |
| `src-tauri/src/lib.rs` | Modify | Replace `crate::tray::init(app.handle())?` with `crate::native_popover::init(app.handle())?` in setup block. Remove second-launch popover handling (NSPopover doesn't fit the same model — instead show dashboard). |
| `src-tauri/src/tray.rs` | Modify | Delete `init`, `toggle_popover`, the TrayIconBuilder code, the 30s tray-title poll. Keep `show_dashboard` and `show_dashboard_with_settings` helpers (still called by IPC + future menu handlers). |
| `src-tauri/src/windows.rs` | Modify | Delete `create_popover` (~150 lines) and `position_popover_under_tray` (~75 lines). Keep `create_dashboard` unchanged. |
| `src-tauri/src/ipc.rs` | Modify | Remove `popover_user_visible` field from `AppState` (added in v0.4.5 fallback attempt, no longer needed). |
| `src-tauri/capabilities/popover.json` | Delete | Popover is no longer a Tauri window; no capability needed. |
| `popover/popover.js` | Modify | Migrate IPC: `invoke('proxy_fetch', {path})` → `fetch(path)`; `invoke('open_dashboard')` → `webkit.messageHandlers.clauge.postMessage({cmd: 'open_dashboard'})`; `setSize` → `postMessage({cmd: 'resize', height})`. Remove `__TAURI__` references entirely. |
| `popover/index.html` | **Unchanged** | Content reused as-is inside WKWebView. |
| `popover/popover.css` | **Unchanged** | Content reused as-is inside WKWebView. |
| `server.js` | Modify | Add static route serving `/popover/*` from the bundled popover/ directory (currently SEA only serves `public/`). |
| `scripts/sea-config.json` | Modify (if needed) | Add popover/ assets to SEA bundle if not already included. |

---

## Phase 1: Setup

### Task 1: Add `objc2-web-kit` dependency

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add the dep**

In `src-tauri/Cargo.toml`, find the existing `[target.'cfg(target_os = "macos")'.dependencies]` block (around line 33-37 currently) and add `objc2-web-kit`:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.6"
objc2-app-kit = { version = "0.3", features = ["NSWindow", "NSResponder", "NSView", "NSPanel", "NSStatusBar", "NSStatusItem", "NSMenu", "NSMenuItem", "NSImage", "NSEvent", "NSPopover", "NSViewController", "NSApplication"] }
objc2-quartz-core = { version = "0.3", features = ["CALayer"] }
objc2-foundation = { version = "0.3", features = ["NSGeometry", "NSString", "NSURL", "NSURLRequest"] }
objc2-web-kit = { version = "0.3", features = ["WKWebView", "WKWebViewConfiguration", "WKUserContentController", "WKScriptMessage", "WKScriptMessageHandler", "WKNavigation", "WKNavigationDelegate"] }
```

Note the expanded `objc2-app-kit` feature list — needed for status bar / menu / popover types.

- [ ] **Step 2: Verify deps resolve**

Run: `cd ~/Projects/clauge/src-tauri && cargo check`
Expected: Finished without errors. Cargo.lock will gain new entries for objc2-web-kit + transitive WebKit bindings.

If you see "unknown feature" errors on objc2-app-kit, check the actual installed crate's `Cargo.toml` at `~/.cargo/registry/src/index.crates.io-*/objc2-app-kit-0.3.*/Cargo.toml` for the correct feature names.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(v3): add objc2-web-kit + extend objc2-app-kit features for v0.5 native popover"
```

---

### Task 2: Create empty `native_popover` module + wire from `lib.rs`

**Files:**
- Create: `src-tauri/src/native_popover.rs`
- Modify: `src-tauri/src/lib.rs:8-12` (mod declarations)

- [ ] **Step 1: Create the module file with a stub**

Create `src-tauri/src/native_popover.rs`:

```rust
//! Native macOS menu bar: NSStatusItem + NSPopover + WKWebView.
//!
//! Replaces Tauri's WebviewWindow-based popover (v0.4.x) with Apple's
//! NSPopover (behavior = applicationDefined) so the popover persists across
//! outside-app clicks like Bartender / iStat Menus. The Tauri WebviewWindow
//! abstraction couldn't reliably keep the popover visible in Accessory mode
//! despite 12+ NSWindow flag combos in v0.4.x — see the v0.5 spec for
//! background.

#[cfg(target_os = "macos")]
pub fn init(_app: &tauri::AppHandle) -> tauri::Result<()> {
    log::info!("native_popover::init stub — implementation lands across subsequent tasks");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
```

- [ ] **Step 2: Add module declaration to lib.rs**

In `src-tauri/src/lib.rs`, find the module declarations at the top (currently `mod ipc; mod menu; mod port_discovery; mod sidecar; mod tray; mod windows;`) and add `native_popover`:

```rust
mod ipc;
mod menu;
mod native_popover;
mod port_discovery;
mod sidecar;
mod tray;
mod windows;
```

- [ ] **Step 3: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -3`
Expected: `Finished` line, no errors. Pre-existing 3 warnings unchanged.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/native_popover.rs src-tauri/src/lib.rs
git commit -m "feat(v3): scaffold native_popover module for v0.5 NSPopover migration"
```

---

## Phase 2: NSStatusItem (replaces Tauri tray)

### Task 3: Create `NSStatusItem` with template icon + left-click handler

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Implement NSStatusItem creation**

Replace the stub `init()` in `src-tauri/src/native_popover.rs` with:

```rust
//! Native macOS menu bar: NSStatusItem + NSPopover + WKWebView.
//! ... (keep existing module doc) ...

#[cfg(target_os = "macos")]
use std::sync::{Arc, Mutex};

#[cfg(target_os = "macos")]
use objc2::rc::Retained;

#[cfg(target_os = "macos")]
pub struct MenuBar {
    pub status_item: Retained<objc2_app_kit::NSStatusItem>,
}

#[cfg(target_os = "macos")]
pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSImage, NSStatusBar, NSVariableStatusItemLength};
    use objc2_foundation::{NSData, NSString};

    // The system status bar lives on the main thread; init() runs in
    // tauri::Builder::setup which is on the main thread.
    let status_bar = unsafe { NSStatusBar::systemStatusBar() };
    let status_item = unsafe { status_bar.statusItemWithLength(NSVariableStatusItemLength) };

    // Load the same template icon Tauri's tray used.
    let icon_bytes = include_bytes!("../icons/tray-icon.png");
    let ns_data = NSData::with_bytes(icon_bytes);
    if let Some(image) = unsafe { NSImage::initWithData(NSImage::alloc(), &ns_data) } {
        unsafe { image.setTemplate(true) };
        if let Some(button) = unsafe { status_item.button() } {
            unsafe { button.setImage(Some(&image)) };
        }
    }

    // Stash on AppHandle state so the status item isn't dropped.
    let menu_bar = MenuBar { status_item };
    app.manage(Arc::new(Mutex::new(menu_bar)));

    log::info!("native_popover: NSStatusItem created");
    Ok(())
}
```

Note: `NSStatusItem` ownership matters — if we don't keep a reference, ARC drops it and the icon disappears. `app.manage()` stores it in Tauri's State so it lives for the app lifetime.

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`
Expected: Finished. If you get errors about unknown methods (e.g. `setTemplate`, `setImage`, `button`), check actual signatures in `~/.cargo/registry/src/index.crates.io-*/objc2-app-kit-0.3.*/src/generated/NSStatusItem.rs` and `NSImage.rs` and adjust.

- [ ] **Step 3: Wire `init()` from lib.rs setup block**

In `src-tauri/src/lib.rs`, find the setup block where `crate::tray::init(app.handle())?` is currently called (around line 95 after `crate::windows::create_popover`). For now, ALSO call native_popover::init AFTER the existing tray init — both will run side by side. We'll remove the Tauri tray in a later task once the native one is fully working.

```rust
crate::windows::create_popover(app.handle())?;
crate::tray::init(app.handle())?;
crate::native_popover::init(app.handle())?;  // NEW — additive for now
```

- [ ] **Step 4: cargo tauri dev + manual smoke**

Run: `pkill -9 -f "target/debug/clauge"; pkill -9 -f cargo-tauri; sleep 2; cd ~/Projects/clauge/src-tauri && RUST_LOG=info cargo tauri dev`

Expected: app launches. **Two tray icons** appear in the menu bar (one from the old Tauri tray + one new NSStatusItem). The native one is on the LEFT (more recently created).

- [ ] **Step 5: Quit dev + commit**

Quit via the OLD Tauri tray's "Quit Clauge" menu (the new NSStatusItem doesn't have a click handler yet).

```bash
git add src-tauri/src/native_popover.rs src-tauri/src/lib.rs
git commit -m "feat(v3): native_popover creates NSStatusItem with template icon"
```

---

### Task 4: Wire `NSStatusItem.button` left-click action handler

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Add a click target action**

We need an Objective-C action selector that fires when the user clicks the status item's button. The pattern: define a target object class (via `objc2::define_class!`), set `button.target = target_obj`, `button.action = selector(handleClick:)`.

Append to `src-tauri/src/native_popover.rs`:

```rust
#[cfg(target_os = "macos")]
use objc2::define_class;

#[cfg(target_os = "macos")]
use objc2_foundation::NSObjectProtocol;

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[thread_kind = objc2::MainThreadOnly]
    #[name = "ClaugeStatusItemTarget"]
    pub struct ClaugeStatusItemTarget;

    unsafe impl NSObjectProtocol for ClaugeStatusItemTarget {}

    impl ClaugeStatusItemTarget {
        #[unsafe(method(handleClick:))]
        fn handle_click(&self, _sender: &objc2_app_kit::NSStatusBarButton) {
            log::info!("native_popover: status item clicked (handler stub — popover toggle wires later)");
        }
    }
);
```

Then in `init()`, after creating the button image, wire the target/action. Update `init()` to:

```rust
        if let Some(button) = unsafe { status_item.button() } {
            unsafe { button.setImage(Some(&image)) };

            let target = unsafe {
                let alloc = ClaugeStatusItemTarget::alloc();
                objc2::msg_send![alloc, init]
            };
            let target_ref: Retained<ClaugeStatusItemTarget> = unsafe { Retained::from_raw(target).unwrap() };
            let sel = objc2::sel!(handleClick:);
            unsafe {
                button.setTarget(Some(&*target_ref));
                button.setAction(Some(sel));
            }
            // Stash target on MenuBar so it isn't dropped (button holds a weak ref).
            // (Updated MenuBar struct below.)
        }
```

Update the `MenuBar` struct to hold the target:

```rust
#[cfg(target_os = "macos")]
pub struct MenuBar {
    pub status_item: Retained<objc2_app_kit::NSStatusItem>,
    pub click_target: Retained<ClaugeStatusItemTarget>,
}
```

And update the `app.manage()` call to pass both fields. Adjust the borrow flow as needed.

(If the exact `setTarget` / `setAction` signature in objc2-app-kit 0.3 differs, check `~/.cargo/registry/src/index.crates.io-*/objc2-app-kit-0.3.*/src/generated/NSControl.rs` — `NSStatusBarButton` inherits from `NSControl`.)

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`
Expected: Finished, no errors.

- [ ] **Step 3: cargo tauri dev + smoke**

Run: kill prior dev, restart `cargo tauri dev`. Click the new (left) tray icon.
Expected: log line `native_popover: status item clicked` appears in the cargo dev terminal.

- [ ] **Step 4: Quit + commit**

```bash
git add src-tauri/src/native_popover.rs
git commit -m "feat(v3): wire NSStatusItem.button click action via ClaugeStatusItemTarget"
```

---

## Phase 3: NSPopover + WKWebView

### Task 5: Create `NSPopover` with `WKWebView` content

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Create NSPopover + WKWebView wiring**

Append to `src-tauri/src/native_popover.rs` (inside `#[cfg(target_os = "macos")]` blocks):

```rust
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPopover, NSPopoverBehavior, NSViewController};

#[cfg(target_os = "macos")]
use objc2_web_kit::{WKWebView, WKWebViewConfiguration};

#[cfg(target_os = "macos")]
use objc2_foundation::{CGRect, CGPoint, CGSize, NSURL, NSURLRequest};

// Update MenuBar struct to hold the popover and webview.
#[cfg(target_os = "macos")]
pub struct MenuBar {
    pub status_item: Retained<objc2_app_kit::NSStatusItem>,
    pub click_target: Retained<ClaugeStatusItemTarget>,
    pub popover: Retained<NSPopover>,
    pub webview: Retained<WKWebView>,
}

// New helper to create the popover, called from init() after the status item.
#[cfg(target_os = "macos")]
fn create_popover(server_port: u16) -> (Retained<NSPopover>, Retained<WKWebView>) {
    use objc2::AllocAnyThread;

    // WKWebView sized for popover content; NSPopover.contentSize will track this.
    let frame = CGRect {
        origin: CGPoint { x: 0.0, y: 0.0 },
        size: CGSize { width: 360.0, height: 500.0 },
    };
    let config = unsafe { WKWebViewConfiguration::new() };
    let webview = unsafe {
        WKWebView::initWithFrame_configuration(
            WKWebView::alloc(),
            frame,
            &config,
        )
    };

    // Load popover content from the SEA sidecar (same-origin to /api).
    let url_str = format!("http://127.0.0.1:{}/popover/index.html", server_port);
    let ns_url_str = objc2_foundation::NSString::from_str(&url_str);
    if let Some(ns_url) = unsafe { NSURL::URLWithString(&ns_url_str) } {
        let request = unsafe { NSURLRequest::requestWithURL(&ns_url) };
        let _ = unsafe { webview.loadRequest(&request) };
    } else {
        log::error!("native_popover: failed to construct NSURL from {}", url_str);
    }

    // NSViewController wrapping the WKWebView.
    let vc = unsafe { NSViewController::new() };
    unsafe { vc.setView(&webview) };

    // NSPopover with applicationDefined behavior — the load-bearing flag.
    let popover = unsafe { NSPopover::new() };
    unsafe {
        popover.setContentViewController(Some(&vc));
        popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
        popover.setAnimates(false);  // Suppress AppKit fade animation
        popover.setContentSize(CGSize { width: 360.0, height: 500.0 });
    }

    (popover, webview)
}
```

Update `init()` to call `create_popover()` after status item creation. Pass `server_port` from `AppState` (may not be set yet at boot — fall back to 3456):

```rust
    // After status_item button setup, before app.manage:
    let port = app
        .try_state::<crate::ipc::AppState>()
        .and_then(|s| s.server_port.lock().ok().and_then(|g| *g))
        .unwrap_or(3456);
    let (popover, webview) = create_popover(port);

    let menu_bar = MenuBar {
        status_item,
        click_target: target_ref,
        popover,
        webview,
    };
    app.manage(Arc::new(Mutex::new(menu_bar)));
```

Note: SEA may not yet be bound at this point (sidecar discover/spawn task runs in parallel from setup). The popover URL load may fail initially. We'll handle this in a later task by re-loading after sidecar binds. For now, the WKWebView will show "could not load page" until SEA is ready — acceptable for first integration.

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -8`

Expected: Finished. If you get errors about unknown types/methods, check `~/.cargo/registry/src/index.crates.io-*/objc2-web-kit-0.3.*/src/generated/` for actual signatures.

- [ ] **Step 3: cargo tauri dev (popover stays hidden — no toggle yet)**

Run: kill + `cargo tauri dev`. App should launch as before (two tray icons). The new NSPopover exists but isn't shown anywhere yet.

- [ ] **Step 4: Quit + commit**

```bash
git add src-tauri/src/native_popover.rs
git commit -m "feat(v3): create NSPopover with WKWebView loading popover from SEA"
```

---

### Task 6: Wire left-click handler to toggle NSPopover

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Update click handler to toggle popover**

The challenge: the `ClaugeStatusItemTarget` instance can't directly access the `MenuBar` (which holds the popover) because it has no reference. We need to share state. Two options:

**Option A (preferred):** store the popover reference on the target itself via an instance variable.

**Option B:** use a global static `Mutex<Option<Retained<NSPopover>>>` that the target reads.

Going with B for simplicity (matches the house pattern of using state via Tauri's `AppState`):

Add at module top:

```rust
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

#[cfg(target_os = "macos")]
static POPOVER_REF: OnceLock<Mutex<Option<Retained<NSPopover>>>> = OnceLock::new();

#[cfg(target_os = "macos")]
static STATUS_BUTTON_REF: OnceLock<Mutex<Option<Retained<objc2_app_kit::NSStatusBarButton>>>> = OnceLock::new();
```

In `init()` after creating the popover, populate them:

```rust
    let _ = POPOVER_REF.set(Mutex::new(Some(popover.clone())));
    if let Some(button) = unsafe { status_item.button() } {
        let _ = STATUS_BUTTON_REF.set(Mutex::new(Some(button.clone())));
    }
```

(The `button` already had its target+action set earlier; this just stashes the reference.)

Update `handle_click` to toggle the popover:

```rust
        #[unsafe(method(handleClick:))]
        fn handle_click(&self, sender: &objc2_app_kit::NSStatusBarButton) {
            let popover_guard = match POPOVER_REF.get() {
                Some(m) => m,
                None => { log::warn!("native_popover: handle_click but POPOVER_REF unset"); return; }
            };
            let popover = match popover_guard.lock().ok().and_then(|g| g.clone()) {
                Some(p) => p,
                None => { log::warn!("native_popover: POPOVER_REF empty"); return; }
            };

            unsafe {
                if popover.isShown() {
                    popover.close();
                } else {
                    popover.showRelativeToRect_ofView_preferredEdge(
                        sender.bounds(),
                        sender,
                        objc2_app_kit::NSRectEdgeMinY,
                    );
                }
            }
        }
```

Note: `Retained<NSPopover>::clone()` increments the refcount via `objc_retain`. Check that the trait is in scope; you may need `use objc2::rc::Retained;` and the `clone` method is already provided.

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`
Expected: Finished, no errors.

- [ ] **Step 3: cargo tauri dev + manual smoke**

Run: kill + `cargo tauri dev`. Click the new (left) tray icon.
Expected:
- First click: popover slides in below the icon (may be empty / show "could not load" since SEA may not be bound yet, OR may show actual content if sidecar bound first)
- Second click: popover closes
- Click outside: **popover STAYS visible** (the test that failed for 12 iterations)

- [ ] **Step 4: Quit + commit**

```bash
git add src-tauri/src/native_popover.rs
git commit -m "feat(v3): NSPopover toggle on tray click + persists across outside clicks"
```

---

### Task 7: Reload WKWebView when sidecar binds

**Files:**
- Modify: `src-tauri/src/native_popover.rs`
- Modify: `src-tauri/src/sidecar.rs` (add hook)

The popover may try to load before the SEA sidecar is bound. Once the sidecar reports its port via `AppState::set_port`, we should reload the WKWebView.

- [ ] **Step 1: Add a public reload helper**

Append to `src-tauri/src/native_popover.rs`:

```rust
#[cfg(target_os = "macos")]
static WEBVIEW_REF: OnceLock<Mutex<Option<Retained<WKWebView>>>> = OnceLock::new();

// In init() after creating webview:
//   let _ = WEBVIEW_REF.set(Mutex::new(Some(webview.clone())));

#[cfg(target_os = "macos")]
pub fn reload_for_port(port: u16) {
    let webview = match WEBVIEW_REF.get().and_then(|m| m.lock().ok().and_then(|g| g.clone())) {
        Some(w) => w,
        None => return,
    };
    let url_str = format!("http://127.0.0.1:{}/popover/index.html", port);
    let ns_url_str = objc2_foundation::NSString::from_str(&url_str);
    if let Some(ns_url) = unsafe { NSURL::URLWithString(&ns_url_str) } {
        let request = unsafe { NSURLRequest::requestWithURL(&ns_url) };
        let _ = unsafe { webview.loadRequest(&request) };
    }
}

#[cfg(not(target_os = "macos"))]
pub fn reload_for_port(_port: u16) {}
```

Update `init()` to populate `WEBVIEW_REF` similar to `POPOVER_REF`.

- [ ] **Step 2: Call from sidecar binding code**

Find where the sidecar reports its port to AppState. Look in `src-tauri/src/sidecar.rs` for `set_port` calls (or in `lib.rs` discover/spawn task — both `DiscoveryResult::External` and `spawn_and_supervise` set port). Wherever `state.set_port(port)` succeeds, immediately follow with:

```rust
crate::native_popover::reload_for_port(port);
```

For `lib.rs` line ~178 (after `state.set_port(port)` for the External branch) and within `sidecar::spawn_and_supervise` (find the equivalent set_port call).

- [ ] **Step 3: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`
Expected: Finished.

- [ ] **Step 4: cargo tauri dev + smoke**

Run: kill + `cargo tauri dev`. Click the new tray icon.
Expected: popover loads `http://127.0.0.1:3456/popover/index.html` BUT may 404 because SEA doesn't yet serve `/popover/*` (we add that in Task 11). For now, expect "404 Not Found" or similar in the popover. The toggle and persistence should still work.

- [ ] **Step 5: Quit + commit**

```bash
git add src-tauri/src/native_popover.rs src-tauri/src/sidecar.rs src-tauri/src/lib.rs
git commit -m "feat(v3): reload native popover WKWebView after SEA sidecar binds"
```

---

## Phase 4: WKScriptMessageHandler (popover JS → Rust IPC bridge)

### Task 8: Define `WKScriptMessageHandler` subclass + register on WKUserContentController

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Define the handler class**

Append to `src-tauri/src/native_popover.rs`:

```rust
#[cfg(target_os = "macos")]
use objc2_web_kit::{WKScriptMessage, WKScriptMessageHandler, WKUserContentController};

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[thread_kind = objc2::MainThreadOnly]
    #[name = "ClaugeScriptHandler"]
    pub struct ClaugeScriptHandler;

    unsafe impl NSObjectProtocol for ClaugeScriptHandler {}

    unsafe impl WKScriptMessageHandler for ClaugeScriptHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn user_content_controller_did_receive_script_message(
            &self,
            _ucc: &WKUserContentController,
            message: &WKScriptMessage,
        ) {
            // message.body() is an NSObject — typically NSDictionary for our cmd payloads.
            let body = unsafe { message.body() };
            // Convert to a string for log + dispatch by `cmd` field.
            // Fast path: extract `cmd` string from NSDictionary.
            handle_script_message(&body);
        }
    }
);

#[cfg(target_os = "macos")]
fn handle_script_message(body: &objc2::runtime::AnyObject) {
    use objc2_foundation::{NSDictionary, NSString};
    // Try to interpret as NSDictionary keyed by string.
    let dict: Option<&NSDictionary<NSString, objc2::runtime::AnyObject>> = unsafe {
        body.downcast_ref::<NSDictionary<NSString, _>>()
    };
    let Some(dict) = dict else {
        log::warn!("native_popover: script message body is not NSDictionary");
        return;
    };
    let cmd_key = NSString::from_str("cmd");
    let cmd_obj = unsafe { dict.objectForKey(&cmd_key) };
    let cmd = match cmd_obj.and_then(|o| unsafe { o.downcast_ref::<NSString>() }.map(|s| s.to_string())) {
        Some(c) => c,
        None => { log::warn!("native_popover: script message missing 'cmd' field"); return; }
    };
    match cmd.as_str() {
        "open_dashboard" => {
            log::info!("native_popover: cmd=open_dashboard (handler stub)");
            // Real dispatch wired in Task 9.
        }
        "resize" => {
            log::info!("native_popover: cmd=resize (handler stub)");
            // Real handler wired in Task 10.
        }
        other => log::warn!("native_popover: unknown script message cmd={}", other),
    }
}
```

Update `create_popover()` to register the handler on the WKUserContentController:

```rust
fn create_popover(server_port: u16) -> (Retained<NSPopover>, Retained<WKWebView>) {
    // ... existing config setup ...
    let config = unsafe { WKWebViewConfiguration::new() };

    // Register script message handler on the user content controller.
    let ucc = unsafe { config.userContentController() };
    let handler = unsafe { Retained::from_raw(objc2::msg_send![ClaugeScriptHandler::alloc(), init]).unwrap() };
    let name = NSString::from_str("clauge");
    unsafe {
        ucc.addScriptMessageHandler_name(&*handler, &name);
    }
    // Stash handler so it lives — WKUserContentController holds a weak ref.
    // Use a static like POPOVER_REF for simplicity.
    let _ = SCRIPT_HANDLER_REF.set(Mutex::new(Some(handler)));

    // ... rest of webview creation ...
}

#[cfg(target_os = "macos")]
static SCRIPT_HANDLER_REF: OnceLock<Mutex<Option<Retained<ClaugeScriptHandler>>>> = OnceLock::new();
```

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -8`
Expected: Finished. Watch for errors on `WKScriptMessageHandler` impl — the `objc2-web-kit` 0.3 API may require different method bindings; check `~/.cargo/registry/src/index.crates.io-*/objc2-web-kit-0.3.*/src/generated/WKScriptMessageHandler.rs`.

- [ ] **Step 3: cargo tauri dev + smoke (handler stub only)**

Run: kill + `cargo tauri dev`. Click new tray icon.
Expected: popover opens, no script messages yet (popover.js still uses __TAURI__).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/native_popover.rs
git commit -m "feat(v3): WKScriptMessageHandler for popover JS → Rust IPC bridge"
```

---

### Task 9: Wire `cmd: 'open_dashboard'` to existing dashboard-show logic

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

The popover JS (after we migrate it in Task 13) will postMessage `{cmd: 'open_dashboard'}`. The Rust handler needs to call the same logic as `tray.rs::show_dashboard_with_settings` OR `ipc.rs::open_dashboard`.

- [ ] **Step 1: Need an AppHandle accessible from the script handler**

Since the script handler is a static-ish object, it needs access to the Tauri AppHandle. Add another OnceLock:

```rust
#[cfg(target_os = "macos")]
static APP_HANDLE_REF: OnceLock<tauri::AppHandle> = OnceLock::new();

// In init() at the top:
let _ = APP_HANDLE_REF.set(app.clone());
```

Update the `handle_script_message` "open_dashboard" arm to actually dispatch:

```rust
        "open_dashboard" => {
            let Some(app) = APP_HANDLE_REF.get() else {
                log::warn!("native_popover: open_dashboard but APP_HANDLE_REF unset");
                return;
            };
            crate::tray::show_dashboard(app);
            // Also close the popover so it doesn't sit on top of the dashboard.
            if let Some(popover_guard) = POPOVER_REF.get() {
                if let Some(popover) = popover_guard.lock().ok().and_then(|g| g.clone()) {
                    unsafe { popover.close() };
                }
            }
        }
```

Verify `crate::tray::show_dashboard` is `pub fn` — if not, make it pub.

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`
Expected: Finished.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/native_popover.rs src-tauri/src/tray.rs
git commit -m "feat(v3): script handler dispatches open_dashboard to existing tray helper"
```

---

### Task 10: Wire `cmd: 'resize'` to NSPopover.contentSize

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Implement resize**

Update the `handle_script_message` "resize" arm:

```rust
        "resize" => {
            // Expect body[height] = number
            let height_key = NSString::from_str("height");
            let height_obj = unsafe { dict.objectForKey(&height_key) };
            let height: f64 = height_obj
                .and_then(|o| unsafe { o.downcast_ref::<objc2_foundation::NSNumber>() })
                .map(|n| n.doubleValue())
                .unwrap_or(0.0);
            if !height.is_finite() || height < 200.0 || height > 800.0 {
                log::warn!("native_popover: resize height {} out of bounds", height);
                return;
            }
            if let Some(popover_guard) = POPOVER_REF.get() {
                if let Some(popover) = popover_guard.lock().ok().and_then(|g| g.clone()) {
                    let new_size = CGSize { width: 360.0, height };
                    unsafe { popover.setContentSize(new_size) };
                }
            }
        }
```

Note: `objc2_foundation::NSNumber` requires the `NSValue` feature on objc2-foundation. Add it to the Cargo.toml deps:

```toml
objc2-foundation = { version = "0.3", features = ["NSGeometry", "NSString", "NSURL", "NSURLRequest", "NSValue"] }
```

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`
Expected: Finished.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/native_popover.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(v3): script handler resize dispatches to NSPopover.contentSize"
```

---

## Phase 5: Right-click NSMenu

### Task 11: Detect right-click on status item button + show NSMenu

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Configure button to send action on both mouse buttons**

In `init()` after `setAction`, add:

```rust
            // Default NSStatusBarButton sends action only on leftMouseUp. Enable
            // right-click so the menu shortcut fires from a single handler.
            let mask = objc2_app_kit::NSEventMaskLeftMouseUp | objc2_app_kit::NSEventMaskRightMouseUp;
            let _: () = unsafe {
                objc2::msg_send![&**button, sendActionOn: mask]
            };
```

(The exact API: `-[NSCell sendActionOn:]` returns the previous mask. NSStatusBarButton inherits from NSButton inherits from NSControl which uses NSCell.)

- [ ] **Step 2: Detect right-click in handle_click**

Update the click handler to check `NSApp.currentEvent().type` to differentiate left vs right:

```rust
        #[unsafe(method(handleClick:))]
        fn handle_click(&self, sender: &objc2_app_kit::NSStatusBarButton) {
            let mtm = objc2::MainThreadMarker::new().unwrap();
            let app = objc2_app_kit::NSApplication::sharedApplication(mtm);
            let event = unsafe { app.currentEvent() };
            let event_type = event.as_ref().map(|e| unsafe { e.r#type() });

            use objc2_app_kit::NSEventType;
            match event_type {
                Some(NSEventType::RightMouseUp) => show_menu(sender),
                _ => toggle_popover(sender),
            }
        }
```

Refactor the existing toggle code into `toggle_popover(sender: &NSStatusBarButton)` (it's the same code that was inside `handle_click`).

- [ ] **Step 3: Add show_menu stub**

```rust
#[cfg(target_os = "macos")]
fn show_menu(_sender: &objc2_app_kit::NSStatusBarButton) {
    log::info!("native_popover: right-click — menu stub (Task 12 implements)");
}

#[cfg(target_os = "macos")]
fn toggle_popover(sender: &objc2_app_kit::NSStatusBarButton) {
    // ... existing toggle logic from handle_click ...
}
```

- [ ] **Step 4: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 5: cargo tauri dev + smoke**

Run: kill + `cargo tauri dev`. Left-click new tray → popover toggles. Right-click new tray → log line "right-click — menu stub" appears.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/native_popover.rs
git commit -m "feat(v3): differentiate left/right click on NSStatusItem button"
```

---

### Task 12: Implement NSMenu with 4 items

**Files:**
- Modify: `src-tauri/src/native_popover.rs`

- [ ] **Step 1: Build the NSMenu**

Add a builder + a target for menu actions:

```rust
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSMenu, NSMenuItem};

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[thread_kind = objc2::MainThreadOnly]
    #[name = "ClaugeMenuTarget"]
    pub struct ClaugeMenuTarget;

    unsafe impl NSObjectProtocol for ClaugeMenuTarget {}

    impl ClaugeMenuTarget {
        #[unsafe(method(menuOpenDashboard:))]
        fn menu_open_dashboard(&self, _sender: &objc2_app_kit::NSMenuItem) {
            if let Some(app) = APP_HANDLE_REF.get() {
                crate::tray::show_dashboard(app);
            }
        }

        #[unsafe(method(menuPreferences:))]
        fn menu_preferences(&self, _sender: &objc2_app_kit::NSMenuItem) {
            if let Some(app) = APP_HANDLE_REF.get() {
                crate::tray::show_dashboard_with_settings(app);
            }
        }

        #[unsafe(method(menuCheckUpdates:))]
        fn menu_check_updates(&self, _sender: &objc2_app_kit::NSMenuItem) {
            let Some(app) = APP_HANDLE_REF.get() else { return };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::ipc::check_for_updates(app).await {
                    log::warn!("Failed to check for updates: {}", e);
                }
            });
        }

        #[unsafe(method(menuQuit:))]
        fn menu_quit(&self, _sender: &objc2_app_kit::NSMenuItem) {
            if let Some(app) = APP_HANDLE_REF.get() {
                app.exit(0);
            }
        }
    }
);

#[cfg(target_os = "macos")]
static MENU_TARGET_REF: OnceLock<Mutex<Option<Retained<ClaugeMenuTarget>>>> = OnceLock::new();
#[cfg(target_os = "macos")]
static MENU_REF: OnceLock<Mutex<Option<Retained<NSMenu>>>> = OnceLock::new();

#[cfg(target_os = "macos")]
fn build_menu() -> (Retained<NSMenu>, Retained<ClaugeMenuTarget>) {
    use objc2::AllocAnyThread;
    let target = unsafe { Retained::from_raw(objc2::msg_send![ClaugeMenuTarget::alloc(), init]).unwrap() };

    let menu = unsafe { NSMenu::new() };

    let items = [
        ("Open Dashboard", objc2::sel!(menuOpenDashboard:), ""),
        ("Preferences\u{2026}", objc2::sel!(menuPreferences:), ","),
        ("Check for Updates", objc2::sel!(menuCheckUpdates:), ""),
    ];
    for (title, sel, key) in items {
        let title_ns = NSString::from_str(title);
        let key_ns = NSString::from_str(key);
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                NSMenuItem::alloc(),
                &title_ns,
                Some(sel),
                &key_ns,
            )
        };
        unsafe { item.setTarget(Some(&*target)) };
        unsafe { menu.addItem(&item) };
    }
    let separator = unsafe { NSMenuItem::separatorItem() };
    unsafe { menu.addItem(&separator) };
    let quit_title = NSString::from_str("Quit Clauge");
    let quit_key = NSString::from_str("q");
    let quit_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(),
            &quit_title,
            Some(objc2::sel!(menuQuit:)),
            &quit_key,
        )
    };
    unsafe { quit_item.setTarget(Some(&*target)) };
    unsafe { menu.addItem(&quit_item) };

    (menu, target)
}
```

In `init()` after creating popover, build the menu and stash:

```rust
    let (menu, menu_target) = build_menu();
    let _ = MENU_REF.set(Mutex::new(Some(menu)));
    let _ = MENU_TARGET_REF.set(Mutex::new(Some(menu_target)));
```

Implement `show_menu`:

```rust
#[cfg(target_os = "macos")]
fn show_menu(sender: &objc2_app_kit::NSStatusBarButton) {
    let menu = match MENU_REF.get().and_then(|m| m.lock().ok().and_then(|g| g.clone())) {
        Some(m) => m,
        None => return,
    };
    // Pop the menu at the button's location.
    if let Some(window) = unsafe { sender.window() } {
        let location = CGPoint { x: 0.0, y: sender.bounds().size.height };
        let _ = unsafe {
            objc2::msg_send![&*menu, popUpMenuPositioningItem: std::ptr::null_mut::<objc2::runtime::AnyObject>(), atLocation: location, inView: sender]
        };
    }
}
```

- [ ] **Step 2: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`

- [ ] **Step 3: cargo tauri dev + smoke**

Run: kill + `cargo tauri dev`.
Expected:
- Right-click new tray → 4-item menu appears
- "Open Dashboard" → dashboard opens
- "Preferences" → dashboard opens with Settings tab
- "Check for Updates" → no immediate visual but log shows check
- "Quit Clauge" → app exits cleanly

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/native_popover.rs
git commit -m "feat(v3): NSMenu (Open Dashboard / Preferences / Updates / Quit) on right-click"
```

---

## Phase 6: SEA serves popover assets

### Task 13: Add `/popover/*` static route to server.js

**Files:**
- Modify: `server.js`
- Possibly: `scripts/build-sidecar.sh` or `scripts/sea-config.json`

- [ ] **Step 1: Find current static route in server.js**

Run: `grep -n "static\|public\|express\|hono\|fastify" ~/Projects/clauge/server.js | head -10`

Read what framework + how it serves public/. The pattern usually looks like:

```javascript
app.use('/static', serveStatic({ root: './public' }));
```

- [ ] **Step 2: Add /popover/* route**

Add a sibling route serving the popover/ directory. Locate where the dashboard `public/` is served and copy the pattern. For Hono:

```javascript
import { serveStatic } from 'hono/bun-server';  // or whatever the existing import is
// ... existing /api routes ...
app.use('/popover/*', serveStatic({
  root: './popover',
  rewriteRequestPath: (path) => path.replace(/^\/popover/, ''),
}));
```

Note: SEA bundles JS into a single binary via esbuild + Node SEA. Static file paths inside the binary may not work directly — `serveStatic` reads from the FS at runtime, not from SEA assets. Check what `public/` does today: are the files copied to the binary's working directory at runtime, or read from a relative path?

If SEA can't serve from `./popover/`, two paths:
- (A) Copy `popover/*` to `public/popover/*` so existing `public/` static serving handles it.
- (B) Embed popover/* into the SEA blob via `scripts/sea-config.json` `assets` field, then read via `sea.getAsset()`.

Pick (A) — simpler. Either:
- Add a build-time copy step in `scripts/build-sidecar.sh` (`cp -r popover dist/public/popover` before bundling)
- OR symlink popover/ into public/ at dev time

Going with the build-script copy for production correctness:

In `scripts/build-sidecar.sh` find the line that bundles server.js (look for `npx esbuild server.js`) and ABOVE it add:

```bash
echo "[build-sidecar] Copying popover assets into public/popover/..."
mkdir -p "$REPO_ROOT/public/popover"
cp -r "$REPO_ROOT/popover/"*.html "$REPO_ROOT/popover/"*.css "$REPO_ROOT/popover/"*.js "$REPO_ROOT/public/popover/"
cp -r "$REPO_ROOT/popover/fonts" "$REPO_ROOT/public/popover/" 2>/dev/null || true
```

Then the existing `public/` serving handles `/popover/*` automatically.

For dev mode where `cargo tauri dev` doesn't always trigger build-sidecar.sh, manually copy:

```bash
mkdir -p ~/Projects/clauge/public/popover
cp ~/Projects/clauge/popover/*.html ~/Projects/clauge/popover/*.css ~/Projects/clauge/popover/*.js ~/Projects/clauge/public/popover/
cp -r ~/Projects/clauge/popover/fonts ~/Projects/clauge/public/popover/ 2>/dev/null || true
```

- [ ] **Step 3: Rebuild SEA + test**

Run:
```bash
cd ~/Projects/clauge && bash scripts/build-sidecar.sh 2>&1 | tail -3
pkill -9 -f "target/debug/clauge"; pkill -9 -f cargo-tauri; sleep 2
cd src-tauri && RUST_LOG=info cargo tauri dev
```

Click new (left) tray icon. Expected: popover opens with **actual content** (rings, finance, today, footer), loaded from SEA.

- [ ] **Step 4: Commit**

```bash
git add server.js scripts/build-sidecar.sh
# also commit any .gitignore changes if public/popover should be ignored
git commit -m "feat(v3): SEA sidecar serves popover/* assets so native WKWebView can load them"
```

---

## Phase 7: popover.js IPC migration

### Task 14: Replace `proxy_fetch` with native `fetch`

**Files:**
- Modify: `popover/popover.js`

- [ ] **Step 1: Replace fetchJson**

In `popover/popover.js` find:

```javascript
const { invoke } = window.__TAURI__.core;
// ...
async function fetchJson(path) {
  return await invoke('proxy_fetch', { path });
}
```

Replace with:

```javascript
async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return await res.json();
}
```

And remove the `const { invoke } = window.__TAURI__.core;` line (or keep it temporarily if other places still use invoke — those are migrated in next tasks).

- [ ] **Step 2: Test in isolation**

Rebuild SEA + restart dev. Click tray. Expected: popover loads, rings populate (if server has data).

- [ ] **Step 3: Commit**

```bash
git add popover/popover.js public/popover/popover.js  # if you also copied to public
git commit -m "refactor(v3): popover.js uses native fetch (same-origin to SEA)"
```

---

### Task 15: Replace `invoke('open_dashboard')` with WKScriptMessageHandler postMessage

**Files:**
- Modify: `popover/popover.js`

- [ ] **Step 1: Replace openDashboard**

In `popover/popover.js` find:

```javascript
async function openDashboard() {
  await invoke('open_dashboard').catch((err) => console.error('open_dashboard failed:', err));
}
```

Replace with:

```javascript
function openDashboard() {
  try {
    window.webkit.messageHandlers.clauge.postMessage({ cmd: 'open_dashboard' });
  } catch (err) {
    console.error('open_dashboard postMessage failed:', err);
  }
}
```

- [ ] **Step 2: Test**

Rebuild SEA + restart dev. Click tray → popover opens. Click "Open →" link in popover footer. Expected: dashboard opens, popover closes (per the Rust handler in Task 9).

- [ ] **Step 3: Commit**

```bash
git add popover/popover.js
git commit -m "refactor(v3): popover.js uses webkit.messageHandlers for open_dashboard"
```

---

### Task 16: Replace `setSize` with postMessage `resize`

**Files:**
- Modify: `popover/popover.js`

- [ ] **Step 1: Replace resizeToContent**

In `popover/popover.js` find the `resizeToContent` function (uses `window.__TAURI__.window.getCurrentWindow().setSize(LogicalSize)`). Replace its body with:

```javascript
function resizeToContent() {
  if (!window.webkit?.messageHandlers?.clauge) return;
  requestAnimationFrame(() => {
    try {
      const root = document.getElementById('root');
      if (!root) return;
      const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
      const height = Math.ceil(root.offsetHeight * zoom);
      if (height < 200 || height > 800) return;
      window.webkit.messageHandlers.clauge.postMessage({ cmd: 'resize', height });
    } catch (err) {
      console.warn('[Clauge popover] resizeToContent failed:', err);
    }
  });
}
```

- [ ] **Step 2: Test**

Rebuild SEA + restart dev. Click tray → popover opens. Verify the popover height matches the content (no ghost area below footer).

- [ ] **Step 3: Commit**

```bash
git add popover/popover.js
git commit -m "refactor(v3): popover.js posts resize via webkit.messageHandlers"
```

---

### Task 17: Drop remaining `__TAURI__` references from popover.js

**Files:**
- Modify: `popover/popover.js`

- [ ] **Step 1: Audit + remove**

Run: `grep -n "__TAURI__\|invoke" ~/Projects/clauge/popover/popover.js`

Any remaining references to `window.__TAURI__` or `invoke('...')` should be removed or migrated. Common leftovers:
- The top-level `const { invoke } = window.__TAURI__.core;` if not already removed
- `invoke('check_for_updates')` if any (probably none after the prefs migration)

Remove or migrate. The popover should run cleanly inside the WKWebView (which has no `__TAURI__`).

- [ ] **Step 2: Final test**

Rebuild SEA + restart. Open popover. Open DevTools (right-click in popover → Inspect). Console should show NO errors related to `__TAURI__ undefined`.

- [ ] **Step 3: Commit**

```bash
git add popover/popover.js
git commit -m "refactor(v3): drop final __TAURI__ refs from popover.js"
```

---

## Phase 8: % chiclet on tray title

### Task 18: Move 30s tray-title poll from `tray.rs` to `native_popover.rs`

**Files:**
- Modify: `src-tauri/src/native_popover.rs`
- Modify: `src-tauri/src/tray.rs` (remove the poll)

- [ ] **Step 1: Find the existing poll in tray.rs**

Run: `grep -n "interval\|set_title\|api/usage" ~/Projects/clauge/src-tauri/src/tray.rs`

The existing 30s poll uses `tokio::time::interval` + `reqwest::get(/api/usage)` + `tray.set_title(format!(" {}%", pct))`.

- [ ] **Step 2: Reimplement in native_popover.rs**

Append to `src-tauri/src/native_popover.rs`:

```rust
#[cfg(target_os = "macos")]
fn spawn_tray_title_poller(app_handle: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let port = app_handle
                .try_state::<crate::ipc::AppState>()
                .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
            let Some(port) = port else { continue };
            let url = format!("http://127.0.0.1:{}/api/usage", port);
            let pct = match reqwest::get(&url).await {
                Ok(resp) => match resp.json::<serde_json::Value>().await {
                    Ok(json) => json.get("plan")
                        .and_then(|p| p.get("fiveHour"))
                        .and_then(|f| f.get("pct"))
                        .and_then(|p| p.as_f64()),
                    Err(_) => None,
                },
                Err(_) => None,
            };
            if let Some(pct) = pct {
                let title = format!(" {}%", pct.round() as i64);
                update_tray_title(&title);
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn update_tray_title(title: &str) {
    let Some(button_guard) = STATUS_BUTTON_REF.get() else { return };
    let button = match button_guard.lock().ok().and_then(|g| g.clone()) {
        Some(b) => b,
        None => return,
    };
    let ns_title = objc2_foundation::NSString::from_str(title);
    unsafe { button.setTitle(&ns_title) };
}
```

In `init()` at the end:

```rust
    spawn_tray_title_poller(app.clone());
```

- [ ] **Step 3: Remove poll from tray.rs**

In `src-tauri/src/tray.rs::init`, find the `tauri::async_runtime::spawn` block that does the 30s poll (around line 78-112) and delete it. The `tray::init` function may now be much smaller — that's expected; we'll fully delete it in Phase 9.

- [ ] **Step 4: Verify compile + smoke**

Run: kill + `cargo tauri dev`. Wait 30s. Expected: NEW tray icon shows `X%` chiclet. (Old Tauri tray no longer updates.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/native_popover.rs src-tauri/src/tray.rs
git commit -m "feat(v3): % chiclet poll moved from tauri tray to NSStatusItem.button.title"
```

---

## Phase 9: Cleanup — delete the old Tauri popover infrastructure

### Task 19: Delete `windows.rs::create_popover` + `position_popover_under_tray`

**Files:**
- Modify: `src-tauri/src/windows.rs`
- Modify: `src-tauri/src/lib.rs` (remove the `create_popover` call)

- [ ] **Step 1: Delete from windows.rs**

In `src-tauri/src/windows.rs`, delete:
- `pub fn create_popover(...)` and its body (~150 lines)
- `pub fn position_popover_under_tray(...)` and its body (~75 lines)

Keep `pub fn create_dashboard(...)` — that's still used.

- [ ] **Step 2: Remove call sites in lib.rs**

In `src-tauri/src/lib.rs::run()` setup block, remove `crate::windows::create_popover(app.handle())?;`.

In the single-instance plugin handler (the `Box::new(|app, _argv, _cwd| { ... })` block in lib.rs), the popover-show logic falls back to dashboard. Update so single-instance just shows the dashboard:

```rust
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    crate::tray::show_dashboard(app);
}))
```

(Confirm `show_dashboard` is `pub` — Task 9 should have already done this.)

- [ ] **Step 3: Verify compile**

Run: `cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -5`

If you get errors about missing `position_popover_under_tray` calls, those are in places that no longer matter (or were in tray.rs::toggle_popover which we'll delete next). Either delete the call sites or keep them inert.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/windows.rs src-tauri/src/lib.rs
git commit -m "refactor(v3): delete Tauri WebviewWindow popover code (replaced by native NSPopover)"
```

---

### Task 20: Delete `tray.rs::init` + `toggle_popover` + Tauri TrayIconBuilder

**Files:**
- Modify: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs` (remove the `tray::init` call)

- [ ] **Step 1: Delete from tray.rs**

In `src-tauri/src/tray.rs`:
- Delete `pub fn init(...)` and its body (the entire TrayIconBuilder block)
- Delete `fn toggle_popover(...)` (no longer called)
- Delete `fn show_popover_with_preferences(...)` if still present
- KEEP `pub fn show_dashboard(app: &AppHandle)` and `pub fn show_dashboard_with_settings(app: &AppHandle)` — both still called

- [ ] **Step 2: Remove call site in lib.rs**

In `src-tauri/src/lib.rs::run()` setup block, remove `crate::tray::init(app.handle())?;`.

- [ ] **Step 3: Verify compile + smoke**

Run: kill + `cargo tauri dev`. Expected: only ONE tray icon (the new NSStatusItem one). The old Tauri tray is gone.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/lib.rs
git commit -m "refactor(v3): delete Tauri TrayIconBuilder code (replaced by native NSStatusItem)"
```

---

### Task 21: Delete `popover.json` capability + remove `popover_user_visible` from AppState

**Files:**
- Delete: `src-tauri/capabilities/popover.json`
- Modify: `src-tauri/src/ipc.rs` (remove field)

- [ ] **Step 1: Delete capability file**

```bash
rm ~/Projects/clauge/src-tauri/capabilities/popover.json
```

- [ ] **Step 2: Remove popover_user_visible**

In `src-tauri/src/ipc.rs`:
- In `pub struct AppState`, remove the `popover_user_visible` field
- In `impl Default for AppState`, remove the corresponding initialization
- Search for any `.popover_user_visible` accesses and remove

Run: `grep -rn "popover_user_visible" ~/Projects/clauge/src-tauri/src/` to find all references.

- [ ] **Step 3: Verify compile + smoke**

Run: kill + `cargo tauri dev`. Expected: app launches, NSStatusItem present, popover toggles, persists across outside clicks.

- [ ] **Step 4: Commit**

```bash
git add -u src-tauri/capabilities src-tauri/src/ipc.rs
git commit -m "refactor(v3): drop popover.json capability + popover_user_visible flag"
```

---

### Task 22: Drop `tauri-plugin-window-state` filter for popover (no longer a window)

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Find and simplify**

In `src-tauri/src/lib.rs`, find the `tauri_plugin_window_state` registration:

```rust
.plugin(
    tauri_plugin_window_state::Builder::default()
        .with_filter(|label| label != "popover")
        .build(),
)
```

Replace with:

```rust
.plugin(tauri_plugin_window_state::Builder::default().build())
```

(No filter needed — there's no popover window anymore.)

- [ ] **Step 2: Verify compile + commit**

```bash
cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -3
git add src-tauri/src/lib.rs
git commit -m "refactor(v3): drop window-state filter for non-existent popover window"
```

---

## Phase 10: Smoke + ship

### Task 23: Full manual smoke test

**No file changes — verification only.**

- [ ] **Step 1: Clean rebuild**

```bash
pkill -9 -f "target/debug/clauge"; pkill -9 -f cargo-tauri; sleep 2
cd ~/Projects/clauge && bash scripts/build-sidecar.sh 2>&1 | tail -3
cd src-tauri && cargo build 2>&1 | tail -3
cd ~/Projects/clauge/src-tauri && RUST_LOG=info cargo tauri dev
```

- [ ] **Step 2: Verify each item**

1. Tray icon appears in menu bar (template, dark/light mode aware) ✓
2. Click tray → popover slides in below icon ✓
3. Click on Finder/Safari/another app → **popover STAYS visible** ✓ (the headline test)
4. Click tray again → popover dismisses cleanly ✓
5. Right-click tray → 4-item menu (Open Dashboard / Preferences / Check Updates / Quit) ✓
6. Right-click → Open Dashboard → dashboard window appears ✓
7. Right-click → Preferences → dashboard opens with Settings tab ✓
8. Right-click → Check for Updates → log shows check (no update available) ✓
9. Right-click → Quit Clauge → clean exit ✓
10. Popover footer "Open →" link → dashboard opens, popover closes ✓
11. After ~30s: tray title shows ` X%` ✓
12. Popover height matches content (no ghost area, no cut) ✓

- [ ] **Step 3: Run test suites**

```bash
cd ~/Projects/clauge/src-tauri && cargo test --locked 2>&1 | grep "^test result"
cd ~/Projects/clauge && npm test 2>&1 | grep "^# (tests|pass|fail)"
```

Expected: cargo 24/24, npm 109/109. ALL tests must pass.

- [ ] **Step 4: Quit cleanly**

Use the new tray's "Quit Clauge" menu item.

---

### Task 24: Bump version + ship

**Files:**
- Modify: `src-tauri/Cargo.toml` (version)
- Modify: `src-tauri/tauri.conf.json` (version)
- Modify: `package.json` (version)
- Modify: `popover/popover.js` (serverVersion fallback)
- Modify: `popover/index.html` (po-meta + about-version literals)

- [ ] **Step 1: Bump 0.4.4 → 0.5.0**

Use `Edit` tool on each file. **This is a major-feature bump** (architectural rewrite of menu bar).

- [ ] **Step 2: Refresh Cargo.lock**

```bash
cd ~/Projects/clauge/src-tauri && cargo check 2>&1 | tail -3
```

- [ ] **Step 3: Final test run**

```bash
cd ~/Projects/clauge/src-tauri && cargo test --locked 2>&1 | grep "^test result"
cd ~/Projects/clauge && npm test 2>&1 | grep "^# (tests|pass|fail)"
```

- [ ] **Step 4: Commit + REQUEST APPROVAL FOR PUSH**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(v3): T44 — v0.5.0 native NSPopover menu bar (rewrite)

Replaces Tauri WebviewWindow-based popover with native NSPopover
(behavior=applicationDefined) controlled by Rust via objc2-app-kit
+ objc2-web-kit. Fixes the persistent-on-outside-click bug that 12+
NSWindow flag combos couldn't solve in Accessory mode.

New native module owns NSStatusItem + NSPopover + WKWebView + NSMenu;
Tauri keeps dashboard + sidecar + IPC + all plugins. Popover content
(HTML/CSS) reused as-is; popover.js IPC layer migrated from
__TAURI__.invoke to webkit.messageHandlers + native fetch (same-origin
to SEA sidecar).

Tests: cargo 24/24, npm 109/109. Manual smoke: persistence, toggle,
right-click menu, % chiclet, dynamic resize all verified.
EOF
)"
```

**STOP HERE.** Per house convention (`feedback_pr_merge_authorization.md`): pushing v3-native, FF-merging main, and tagging v0.5.0 are SHARED-STATE WRITES that need explicit per-action user approval. Show the user the commit + the planned push/tag commands and wait for "yes" before proceeding.

- [ ] **Step 5: After explicit user approval — push + tag**

```bash
git push origin v3-native
git checkout main && git merge --ff-only v3-native && git push origin main
git tag -a v0.5.0 -m "v0.5.0 — native NSPopover menu bar (persistence + no flicker)"
git push origin v0.5.0
```

- [ ] **Step 6: Monitor GHA + verify gh-pages**

```bash
sleep 20 && gh run list --workflow release.yml --limit 1 --json databaseId,status,conclusion
# Then poll for completion (~10 min)
# After success: verify 4 release assets + gh-pages mirror commit
```

---

## Self-Review

1. **Spec coverage**: each section in the spec maps to at least one task. ✓
2. **Placeholder scan**: code blocks complete; commands include expected output where deterministic; no TODOs. ✓
3. **Type consistency**: `MenuBar`, `ClaugeStatusItemTarget`, `ClaugeScriptHandler`, `ClaugeMenuTarget` — names consistent across tasks. `OnceLock<Mutex<Option<Retained<T>>>>` pattern reused for static refs. ✓
4. **Caveat:** Several Cocoa method bindings in `objc2-web-kit` 0.3 are best-guesses based on header conventions; the implementer must verify exact signatures against the installed crate's `src/generated/` files and adjust. This is called out in each affected task.
