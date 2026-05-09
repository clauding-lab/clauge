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

#[cfg(target_os = "macos")]
use objc2_app_kit::{NSPopover, NSStatusItem};

#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

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
static STATUS_ITEM_REF: OnceLock<Mutex<Option<MainThreadCell<NSStatusItem>>>> = OnceLock::new();

#[cfg(target_os = "macos")]
static CLICK_TARGET_REF: OnceLock<Mutex<Option<MainThreadCell<ClaugeStatusItemTarget>>>> =
    OnceLock::new();

#[cfg(target_os = "macos")]
static POPOVER_REF: OnceLock<Mutex<Option<MainThreadCell<NSPopover>>>> = OnceLock::new();

#[cfg(target_os = "macos")]
static WEBVIEW_REF: OnceLock<Mutex<Option<MainThreadCell<WKWebView>>>> = OnceLock::new();

#[cfg(target_os = "macos")]
static VIEW_CONTROLLER_REF: OnceLock<Mutex<Option<MainThreadCell<objc2_app_kit::NSViewController>>>> =
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
fn create_popover(
    mtm: objc2::MainThreadMarker,
    server_port: u16,
) -> (
    Retained<NSPopover>,
    Retained<WKWebView>,
    Retained<objc2_app_kit::NSViewController>,
) {
    use objc2_app_kit::{NSPopoverBehavior, NSViewController};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURL, NSURLRequest};
    use objc2_web_kit::WKWebViewConfiguration;

    let frame = NSRect {
        origin: NSPoint { x: 0.0, y: 0.0 },
        size: NSSize {
            width: 360.0,
            height: 500.0,
        },
    };

    let config: Retained<WKWebViewConfiguration> =
        unsafe { WKWebViewConfiguration::init(mtm.alloc::<WKWebViewConfiguration>()) };

    let webview: Retained<WKWebView> = unsafe {
        WKWebView::initWithFrame_configuration(mtm.alloc::<WKWebView>(), frame, &config)
    };

    // Load popover content from the SEA sidecar (same-origin to /api). At
    // boot time the sidecar may not yet be bound; reload_for_port re-loads
    // once sidecar.rs reports its real port.
    let url_str = format!("http://127.0.0.1:{}/popover/index.html", server_port);
    let ns_url_str = NSString::from_str(&url_str);
    if let Some(ns_url) = unsafe { NSURL::URLWithString(&ns_url_str) } {
        let request = NSURLRequest::requestWithURL(&ns_url);
        let _ = unsafe { webview.loadRequest(&request) };
    } else {
        log::error!("native_popover: failed to construct NSURL from {}", url_str);
    }

    // NSViewController wraps the WKWebView so NSPopover has a
    // contentViewController to host.
    let vc = NSViewController::new(mtm);
    unsafe { vc.setView(&webview) };

    // applicationDefined behavior is the load-bearing decision — the popover
    // ignores app deactivation and outside clicks. Animations stay off so
    // size changes (Task 10) don't flicker.
    let popover = NSPopover::new(mtm);
    unsafe {
        popover.setContentViewController(Some(&vc));
        popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
        popover.setAnimates(false);
        popover.setContentSize(NSSize {
            width: 360.0,
            height: 500.0,
        });
    }

    (popover, webview, vc)
}

#[cfg(target_os = "macos")]
pub fn init(app: &tauri::AppHandle) -> tauri::Result<()> {
    use objc2::{sel, AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSImage, NSStatusBar, NSVariableStatusItemLength};
    use objc2_foundation::NSData;
    use tauri::Manager;

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

    // SEA sidecar may not yet have bound by the time setup() runs (its
    // discover/spawn task is detached). Use the recorded port if present;
    // otherwise fall back to the current default and let reload_for_port
    // (Task 7) update the WKWebView once sidecar reports.
    let port = app
        .try_state::<crate::ipc::AppState>()
        .and_then(|s| s.server_port.lock().ok().and_then(|g| *g))
        .unwrap_or(3456);
    let (popover, webview, vc) = create_popover(mtm, port);

    // Stash all retained references. Without these, ARC drops the underlying
    // Cocoa objects after init() returns and the menu bar / popover stop
    // working. NSStatusBarButton holds only a weak reference to its target.
    let _ = STATUS_ITEM_REF.set(Mutex::new(Some(MainThreadCell(status_item))));
    let _ = CLICK_TARGET_REF.set(Mutex::new(Some(MainThreadCell(target))));
    let _ = POPOVER_REF.set(Mutex::new(Some(MainThreadCell(popover))));
    let _ = WEBVIEW_REF.set(Mutex::new(Some(MainThreadCell(webview))));
    let _ = VIEW_CONTROLLER_REF.set(Mutex::new(Some(MainThreadCell(vc))));

    log::info!("native_popover: NSStatusItem + NSPopover created (port={})", port);
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
