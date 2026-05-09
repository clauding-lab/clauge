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
use objc2_web_kit::{WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView};

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
static SCRIPT_HANDLER_REF: OnceLock<Mutex<Option<MainThreadCell<ClaugeScriptHandler>>>> =
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
        fn handle_click(&self, sender: &objc2_app_kit::NSStatusBarButton) {
            toggle_popover(sender);
        }
    }
);

#[cfg(target_os = "macos")]
define_class!(
    // ClaugeScriptHandler bridges popover JS → Rust IPC. Registered on the
    // WKWebView's user content controller under the name "clauge"; the
    // popover JS calls window.webkit.messageHandlers.clauge.postMessage({...}).
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
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
            // Body is typically NSDictionary{cmd, …}; per Apple docs,
            // allowed JS-side types are NSNumber/NSString/NSDate/NSArray/
            // NSDictionary/NSNull, so we cope with all-else by logging and
            // dropping.
            let body = unsafe { message.body() };
            handle_script_message(&body);
        }
    }
);

#[cfg(target_os = "macos")]
fn handle_script_message(body: &objc2::runtime::AnyObject) {
    use objc2_foundation::{NSDictionary, NSString};

    let dict: &NSDictionary = match body.downcast_ref::<NSDictionary>() {
        Some(d) => d,
        None => {
            log::warn!("native_popover: script message body is not NSDictionary");
            return;
        }
    };

    let cmd_key = NSString::from_str("cmd");
    let cmd_obj = dict.objectForKey(&cmd_key);
    let cmd = match cmd_obj
        .as_ref()
        .and_then(|o| o.downcast_ref::<NSString>().map(|s| s.to_string()))
    {
        Some(c) => c,
        None => {
            log::warn!("native_popover: script message missing 'cmd' field");
            return;
        }
    };

    match cmd.as_str() {
        "open_dashboard" => {
            log::info!("native_popover: cmd=open_dashboard (handler stub — Task 9 wires)");
        }
        "resize" => {
            log::info!("native_popover: cmd=resize (handler stub — Task 10 wires)");
        }
        other => log::warn!("native_popover: unknown script message cmd={}", other),
    }
}

#[cfg(target_os = "macos")]
fn toggle_popover(sender: &objc2_app_kit::NSStatusBarButton) {
    use objc2_app_kit::NSView;
    use objc2_foundation::NSRectEdge;

    let popover = match POPOVER_REF.get().and_then(|m| {
        m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get()))
    }) {
        Some(p) => p,
        None => {
            log::warn!("native_popover: toggle_popover but POPOVER_REF unset");
            return;
        }
    };

    if popover.isShown() {
        popover.close();
    } else {
        // NSStatusBarButton inherits from NSView; pass it as the positioning
        // view so AppKit anchors the popover under the menu-bar icon.
        let view: &NSView = sender;
        popover.showRelativeToRect_ofView_preferredEdge(view.bounds(), view, NSRectEdge::MinY);
    }
}

#[cfg(target_os = "macos")]
fn create_popover(
    mtm: objc2::MainThreadMarker,
    server_port: u16,
) -> (
    Retained<NSPopover>,
    Retained<WKWebView>,
    Retained<objc2_app_kit::NSViewController>,
    Retained<ClaugeScriptHandler>,
) {
    use objc2::runtime::ProtocolObject;
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

    // Build + register the script-message handler BEFORE the WKWebView is
    // initialized — `addScriptMessageHandler:name:` retains the handler
    // weakly, but timing-wise we want the bridge live before any page load.
    let handler: Retained<ClaugeScriptHandler> = unsafe {
        let alloc = mtm.alloc::<ClaugeScriptHandler>();
        objc2::msg_send![alloc, init]
    };
    let ucc = unsafe { config.userContentController() };
    let name = NSString::from_str("clauge");
    let proto = ProtocolObject::from_ref(&*handler);
    unsafe { ucc.addScriptMessageHandler_name(proto, &name) };

    let webview: Retained<WKWebView> = unsafe {
        WKWebView::initWithFrame_configuration(mtm.alloc::<WKWebView>(), frame, &config)
    };

    // Load popover content from the SEA sidecar (same-origin to /api). At
    // boot time the sidecar may not yet be bound; reload_for_port re-loads
    // once sidecar.rs reports its real port.
    let url_str = format!("http://127.0.0.1:{}/popover/index.html", server_port);
    let ns_url_str = NSString::from_str(&url_str);
    if let Some(ns_url) = NSURL::URLWithString(&ns_url_str) {
        let request = NSURLRequest::requestWithURL(&ns_url);
        let _ = unsafe { webview.loadRequest(&request) };
    } else {
        log::error!("native_popover: failed to construct NSURL from {}", url_str);
    }

    // NSViewController wraps the WKWebView so NSPopover has a
    // contentViewController to host.
    let vc = NSViewController::new(mtm);
    vc.setView(&webview);

    // applicationDefined behavior is the load-bearing decision — the popover
    // ignores app deactivation and outside clicks. Animations stay off so
    // size changes (Task 10) don't flicker.
    let popover = NSPopover::new(mtm);
    popover.setContentViewController(Some(&vc));
    popover.setBehavior(NSPopoverBehavior::ApplicationDefined);
    popover.setAnimates(false);
    popover.setContentSize(NSSize {
        width: 360.0,
        height: 500.0,
    });

    (popover, webview, vc, handler)
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
    let (popover, webview, vc, script_handler) = create_popover(mtm, port);

    // Stash all retained references. Without these, ARC drops the underlying
    // Cocoa objects after init() returns and the menu bar / popover stop
    // working. NSStatusBarButton holds only a weak reference to its target;
    // WKUserContentController holds only a weak reference to message handlers.
    let _ = STATUS_ITEM_REF.set(Mutex::new(Some(MainThreadCell(status_item))));
    let _ = CLICK_TARGET_REF.set(Mutex::new(Some(MainThreadCell(target))));
    let _ = POPOVER_REF.set(Mutex::new(Some(MainThreadCell(popover))));
    let _ = WEBVIEW_REF.set(Mutex::new(Some(MainThreadCell(webview))));
    let _ = VIEW_CONTROLLER_REF.set(Mutex::new(Some(MainThreadCell(vc))));
    let _ = SCRIPT_HANDLER_REF.set(Mutex::new(Some(MainThreadCell(script_handler))));

    log::info!("native_popover: NSStatusItem + NSPopover created (port={})", port);
    Ok(())
}

/// Re-load the popover WKWebView at the freshly-bound SEA sidecar port.
/// Called from sidecar.rs and lib.rs immediately after `state.set_port`
/// succeeds so the popover stops showing "could not load" once the server
/// is actually ready.
///
/// WKWebView is main-thread-only; callers may invoke from any thread, so the
/// actual reload is hopped to the main thread via `run_on_main_thread`.
#[cfg(target_os = "macos")]
pub fn reload_for_port(app: &tauri::AppHandle, port: u16) {
    let _ = app.run_on_main_thread(move || {
        use objc2_foundation::{NSString, NSURL, NSURLRequest};

        let webview = match WEBVIEW_REF.get().and_then(|m| {
            m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get()))
        }) {
            Some(w) => w,
            None => return,
        };

        let url_str = format!("http://127.0.0.1:{}/popover/index.html", port);
        let ns_url_str = NSString::from_str(&url_str);
        if let Some(ns_url) = NSURL::URLWithString(&ns_url_str) {
            let request = NSURLRequest::requestWithURL(&ns_url);
            let _ = unsafe { webview.loadRequest(&request) };
            log::info!("native_popover: WKWebView reloaded at {}", url_str);
        } else {
            log::warn!(
                "native_popover: reload_for_port failed to construct NSURL for {}",
                url_str
            );
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn reload_for_port(_app: &tauri::AppHandle, _port: u16) {}

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) -> tauri::Result<()> {
    Ok(())
}
