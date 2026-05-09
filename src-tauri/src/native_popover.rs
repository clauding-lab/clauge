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
use objc2_app_kit::{NSMenu, NSMenuItem, NSPopover, NSStatusItem};

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

// Stash the AppHandle so the script handler and (later) menu actions can
// reach the existing IPC layer without plumbing it through every closure.
#[cfg(target_os = "macos")]
static APP_HANDLE_REF: OnceLock<tauri::AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
static MENU_REF: OnceLock<Mutex<Option<MainThreadCell<NSMenu>>>> = OnceLock::new();

#[cfg(target_os = "macos")]
static MENU_TARGET_REF: OnceLock<Mutex<Option<MainThreadCell<ClaugeMenuTarget>>>> =
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
            use objc2::MainThreadMarker;
            use objc2_app_kit::{NSApplication, NSEventType};

            // The NSStatusBarButton fires the same selector for both mouse
            // buttons (we set sendActionOn:Left|Right above). NSApp tracks
            // the most recent event globally — peek at its type to route.
            let mtm = match MainThreadMarker::new() {
                Some(m) => m,
                None => {
                    log::warn!("native_popover: handle_click off main thread; ignoring");
                    return;
                }
            };
            let app = NSApplication::sharedApplication(mtm);
            let event_type = app.currentEvent().map(|e| e.r#type());

            match event_type {
                Some(NSEventType::RightMouseUp) => show_menu(sender),
                _ => toggle_popover(sender),
            }
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
            let Some(app) = APP_HANDLE_REF.get() else {
                log::warn!("native_popover: open_dashboard but APP_HANDLE_REF unset");
                return;
            };
            crate::tray::show_dashboard(app);
            // Close the popover so it doesn't sit on top of the dashboard.
            if let Some(popover) = POPOVER_REF
                .get()
                .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
            {
                popover.close();
            }
        }
        "resize" => {
            use objc2_foundation::{NSNumber, NSSize};

            let height_key = NSString::from_str("height");
            let height_obj = dict.objectForKey(&height_key);
            let height: f64 = height_obj
                .as_ref()
                .and_then(|o| o.downcast_ref::<NSNumber>())
                .map(|n| n.doubleValue())
                .unwrap_or(0.0);
            // Bounds match popover.js's resizeToContent clamp; an out-of-range
            // value usually means a measurement bug on the JS side, so log
            // and refuse instead of forcing an absurd popover size.
            if !height.is_finite() || !(200.0..=800.0).contains(&height) {
                log::warn!("native_popover: resize height {} out of bounds", height);
                return;
            }
            if let Some(popover) = POPOVER_REF
                .get()
                .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
            {
                popover.setContentSize(NSSize {
                    width: 360.0,
                    height,
                });
            }
        }
        other => log::warn!("native_popover: unknown script message cmd={}", other),
    }
}

#[cfg(target_os = "macos")]
define_class!(
    // ClaugeMenuTarget receives the right-click NSMenu actions. Same NSObject
    // subclass pattern as ClaugeStatusItemTarget; one method per item.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ClaugeMenuTarget"]
    pub struct ClaugeMenuTarget;

    unsafe impl NSObjectProtocol for ClaugeMenuTarget {}

    impl ClaugeMenuTarget {
        #[unsafe(method(menuOpenDashboard:))]
        fn menu_open_dashboard(&self, _sender: &NSMenuItem) {
            if let Some(app) = APP_HANDLE_REF.get() {
                crate::tray::show_dashboard(app);
            }
        }

        #[unsafe(method(menuPreferences:))]
        fn menu_preferences(&self, _sender: &NSMenuItem) {
            if let Some(app) = APP_HANDLE_REF.get() {
                crate::tray::show_dashboard_with_settings(app);
            }
        }

        #[unsafe(method(menuCheckUpdates:))]
        fn menu_check_updates(&self, _sender: &NSMenuItem) {
            let Some(app) = APP_HANDLE_REF.get() else {
                return;
            };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::ipc::check_for_updates(app).await {
                    log::warn!("Failed to check for updates: {}", e);
                }
            });
        }

        #[unsafe(method(menuQuit:))]
        fn menu_quit(&self, _sender: &NSMenuItem) {
            if let Some(app) = APP_HANDLE_REF.get() {
                app.exit(0);
            }
        }
    }
);

#[cfg(target_os = "macos")]
fn build_menu(mtm: objc2::MainThreadMarker) -> (Retained<NSMenu>, Retained<ClaugeMenuTarget>) {
    use objc2_foundation::NSString;

    let target: Retained<ClaugeMenuTarget> = unsafe {
        let alloc = mtm.alloc::<ClaugeMenuTarget>();
        objc2::msg_send![alloc, init]
    };
    let menu = NSMenu::new(mtm);

    // (label, selector, key-equivalent). Cmd+, on Preferences mirrors the
    // app menu shortcut; the others have no key-equivalent.
    let items: [(&str, objc2::runtime::Sel, &str); 3] = [
        ("Open Dashboard", objc2::sel!(menuOpenDashboard:), ""),
        ("Preferences\u{2026}", objc2::sel!(menuPreferences:), ","),
        ("Check for Updates", objc2::sel!(menuCheckUpdates:), ""),
    ];
    for (title, sel, key) in items {
        let title_ns = NSString::from_str(title);
        let key_ns = NSString::from_str(key);
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc::<NSMenuItem>(),
                &title_ns,
                Some(sel),
                &key_ns,
            )
        };
        unsafe { item.setTarget(Some(target.as_ref())) };
        menu.addItem(&item);
    }

    let separator = NSMenuItem::separatorItem(mtm);
    menu.addItem(&separator);

    let quit_title = NSString::from_str("Quit Clauge");
    let quit_key = NSString::from_str("q");
    let quit_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc::<NSMenuItem>(),
            &quit_title,
            Some(objc2::sel!(menuQuit:)),
            &quit_key,
        )
    };
    unsafe { quit_item.setTarget(Some(target.as_ref())) };
    menu.addItem(&quit_item);

    (menu, target)
}

#[cfg(target_os = "macos")]
fn show_menu(sender: &objc2_app_kit::NSStatusBarButton) {
    use objc2_app_kit::NSView;
    use objc2_foundation::NSPoint;

    let menu = match MENU_REF
        .get()
        .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
    {
        Some(m) => m,
        None => {
            log::warn!("native_popover: show_menu but MENU_REF unset");
            return;
        }
    };
    // Anchor the menu under the bottom-left of the status item button so it
    // appears below the icon, like the AppKit-default tray menu.
    let view: &NSView = sender;
    let location = NSPoint {
        x: 0.0,
        y: view.bounds().size.height,
    };
    menu.popUpMenuPositioningItem_atLocation_inView(None, location, Some(view));
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

    // Make AppHandle available to script-handler / menu callbacks below.
    let _ = APP_HANDLE_REF.set(app.clone());

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
            // NSStatusBarButton's default action mask is leftMouseUp only.
            // Add rightMouseUp so the menu shortcut goes through the same
            // selector — handle_click then differentiates by inspecting
            // NSApp.currentEvent().type.
            let mask = objc2_app_kit::NSEventMask::LeftMouseUp
                | objc2_app_kit::NSEventMask::RightMouseUp;
            button.sendActionOn(mask);
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
    let (menu, menu_target) = build_menu(mtm);

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
    let _ = MENU_REF.set(Mutex::new(Some(MainThreadCell(menu))));
    let _ = MENU_TARGET_REF.set(Mutex::new(Some(MainThreadCell(menu_target))));

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
