//! Native macOS menu bar: NSStatusItem + NSPopover + WKWebView.
//!
//! Replaces Tauri's WebviewWindow-based popover (v0.4.x) with Apple's
//! NSPopover (`behavior = applicationDefined`) so the popover persists across
//! outside-app clicks like Bartender / iStat Menus. The Tauri WebviewWindow
//! abstraction couldn't reliably keep the popover visible in Accessory mode
//! despite 12+ NSWindow flag combos in v0.4.x — see the v0.5 spec for
//! background.

#[cfg(target_os = "macos")]
use std::sync::{Mutex, OnceLock};

#[cfg(target_os = "macos")]
use objc2::rc::Retained;

#[cfg(target_os = "macos")]
use objc2::{define_class, MainThreadOnly};

#[cfg(target_os = "macos")]
use objc2::runtime::NSObject;

#[cfg(target_os = "macos")]
use objc2_foundation::NSObjectProtocol;

// MainThreadCell wraps a Retained<T> for storage in a `static`. AppKit
// objects (NSStatusItem, NSPopover, WKWebView, …) are main-thread-only and
// `Retained<T>` therefore is neither `Send` nor `Sync`. This module is
// disciplined: every `.lock()`/access happens on the main thread (Tauri's
// setup callback runs there; click handlers are `MainThreadOnly`-gated by
// the `define_class!` macro). Asserting Send+Sync here is sound under that
// invariant; storing anywhere else is unsafe.
#[cfg(target_os = "macos")]
struct MainThreadCell<T: objc2::Message>(Retained<T>);

#[cfg(target_os = "macos")]
unsafe impl<T: objc2::Message> Send for MainThreadCell<T> {}
#[cfg(target_os = "macos")]
unsafe impl<T: objc2::Message> Sync for MainThreadCell<T> {}

#[cfg(target_os = "macos")]
impl<T: objc2::Message> MainThreadCell<T> {
    #[allow(dead_code)]
    fn get(&self) -> Retained<T> {
        self.0.clone()
    }
}

#[cfg(target_os = "macos")]
static STATUS_ITEM_REF: OnceLock<Mutex<Option<MainThreadCell<objc2_app_kit::NSStatusItem>>>> =
    OnceLock::new();

#[cfg(target_os = "macos")]
static CLICK_TARGET_REF: OnceLock<Mutex<Option<MainThreadCell<ClaugeStatusItemTarget>>>> =
    OnceLock::new();

#[cfg(target_os = "macos")]
define_class!(
    // ClaugeStatusItemTarget receives -handleClick: from NSStatusBarButton.
    // Subclass exists only to provide an Objective-C action selector — no
    // ivars, no super-init customization needed.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ClaugeStatusItemTarget"]
    pub struct ClaugeStatusItemTarget;

    unsafe impl NSObjectProtocol for ClaugeStatusItemTarget {}

    impl ClaugeStatusItemTarget {
        #[unsafe(method(handleClick:))]
        fn handle_click(&self, _sender: &objc2::runtime::AnyObject) {
            log::info!("native_popover: status item clicked (popover toggle wires later)");
        }
    }
);

#[cfg(target_os = "macos")]
pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    use objc2::{sel, AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSImage, NSStatusBar, NSVariableStatusItemLength};
    use objc2_foundation::NSData;

    let _ = app;

    // The system status bar is a main-thread object; init() runs in
    // tauri::Builder::setup which Tauri guarantees is the main thread.
    let mtm = match MainThreadMarker::new() {
        Some(m) => m,
        None => {
            log::error!("native_popover::init called off the main thread; skipping");
            return Ok(());
        }
    };

    let status_bar = NSStatusBar::systemStatusBar();
    let status_item = status_bar.statusItemWithLength(NSVariableStatusItemLength);

    // Build the click target up-front so we can wire it onto the button below.
    // No ivars on ClaugeStatusItemTarget, so plain alloc + init is enough.
    let target: Retained<ClaugeStatusItemTarget> = unsafe {
        let alloc = mtm.alloc::<ClaugeStatusItemTarget>();
        objc2::msg_send![alloc, init]
    };

    // Load the same template icon Tauri's tray uses — keeps visual parity
    // during the side-by-side rollout.
    let icon_bytes = include_bytes!("../icons/tray-icon.png");
    let ns_data = NSData::with_bytes(icon_bytes);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &ns_data) {
        image.setTemplate(true);
        if let Some(button) = status_item.button(mtm) {
            button.setImage(Some(&image));
            unsafe {
                button.setTarget(Some(target.as_ref()));
                button.setAction(Some(sel!(handleClick:)));
            }
        }
    } else {
        log::warn!("native_popover: failed to decode tray-icon.png into NSImage");
    }

    // Stash the status item AND the click target. NSStatusBarButton holds a
    // weak reference to its target — without our retained handle, ARC drops
    // the target after init() returns and clicks become no-ops. Same logic
    // for the status item: dropping kills the menu-bar icon.
    let _ = STATUS_ITEM_REF.set(Mutex::new(Some(MainThreadCell(status_item))));
    let _ = CLICK_TARGET_REF.set(Mutex::new(Some(MainThreadCell(target))));

    log::info!("native_popover: NSStatusItem created");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
