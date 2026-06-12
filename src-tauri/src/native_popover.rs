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
        debug_assert!(
            objc2::MainThreadMarker::new().is_some(),
            "MainThreadCell::get called off main thread — unsoundness; see module doc"
        );
        self.0.clone()
    }
}

// Resize bounds for the popover's contentSize, mirrored from the popover JS
// clamp in popover.js::resizeToContent. If you change one, change both.
#[cfg(target_os = "macos")]
const MIN_POPOVER_HEIGHT: f64 = 200.0;
#[cfg(target_os = "macos")]
// Bumped from 800 → 1200 in v0.9.1 — the redesigned popover renders Session
// hero gauge + Weekly + Sonnet + Design + Routines + Extra + stats grid +
// spend chart + 3 action items + 4 footer rows. Mirrored in popover.js
// resizeToContent's height clamp.
const MAX_POPOVER_HEIGHT: f64 = 1200.0;
#[cfg(target_os = "macos")]
// v0.9.1 redesign: down from 360 to match CodexBar's spacious 340px popover.
const POPOVER_WIDTH: f64 = 340.0;

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
static VIEW_CONTROLLER_REF: OnceLock<
    Mutex<Option<MainThreadCell<objc2_app_kit::NSViewController>>>,
> = OnceLock::new();

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
static MENU_TARGET_REF: OnceLock<Mutex<Option<MainThreadCell<ClaugeMenuTarget>>>> = OnceLock::new();

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
            if !height.is_finite() || !(MIN_POPOVER_HEIGHT..=MAX_POPOVER_HEIGHT).contains(&height) {
                log::warn!("native_popover: resize height {} out of bounds", height);
                return;
            }
            if let Some(popover) = POPOVER_REF
                .get()
                .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
            {
                popover.setContentSize(NSSize {
                    width: POPOVER_WIDTH,
                    height,
                });
            }
        }
        "quit" => {
            // v1.2.0: the ✕ Quit button and ⌘Q have posted {cmd:'quit'} since
            // the v0.5.0 native-popover migration, but no arm existed — the
            // message died in the catch-all below. Mirrors menu_quit; sidecar
            // teardown + port-file cleanup run downstream in lib.rs's
            // RunEvent::ExitRequested handler.
            if let Some(app) = APP_HANDLE_REF.get() {
                app.exit(0);
            } else {
                log::warn!("native_popover: quit but APP_HANDLE_REF unset");
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

        #[unsafe(method(menuToggleAlerts:))]
        fn menu_toggle_alerts(&self, sender: &NSMenuItem) {
            let Some(app) = APP_HANDLE_REF.get() else {
                return;
            };
            let app = app.clone();
            // Reconcile-only: compute the target from the current checkmark,
            // POST it, then set the checkmark from the server's authoritative
            // response below. No optimistic flip — on POST failure the
            // checkmark stays as-is.
            let current_on = sender.state() == objc2_app_kit::NSControlStateValueOn;
            let next = !current_on;
            tauri::async_runtime::spawn(async move {
                use tauri::Manager;
                let port = app
                    .try_state::<crate::ipc::AppState>()
                    .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
                let Some(port) = port else {
                    log::warn!("alerts toggle: no server port yet");
                    return;
                };
                let url = format!("http://127.0.0.1:{port}/api/config/alerts");
                let body = serde_json::json!({ "enabled": next });
                let enabled = match crate::http_client::LOCAL_CLIENT
                    .post(&url)
                    .json(&body)
                    .send()
                    .await
                {
                    Ok(resp) => match resp.json::<serde_json::Value>().await {
                        Ok(json) => json
                            .get("alertsEnabled")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(next),
                        Err(e) => {
                            log::warn!("alerts toggle: response parse failed: {e}");
                            next
                        }
                    },
                    Err(e) => {
                        log::warn!("alerts toggle: POST failed: {e}");
                        return; // leave the checkmark as-is; server unchanged
                    }
                };
                set_alerts_menu_checkmark(&app, enabled);
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

    // "Alerts: On/Off" toggle. Checkmark reflects alerts.enabled; the action
    // POSTs /api/config/alerts { enabled: !current }. Starts checked (prefs
    // default all-on); seed_alerts_menu_state() reconciles to the real value.
    let alerts_title = NSString::from_str("Alerts");
    let empty_key = NSString::from_str("");
    let alerts_item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            mtm.alloc::<NSMenuItem>(),
            &alerts_title,
            Some(objc2::sel!(menuToggleAlerts:)),
            &empty_key,
        )
    };
    unsafe {
        alerts_item.setTarget(Some(target.as_ref()));
        alerts_item.setState(objc2_app_kit::NSControlStateValueOn);
    }
    menu.addItem(&alerts_item);

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

/// Set the "Alerts" menu item checkmark. The NSMenuItem is the FIRST item
/// whose action selector is `menuToggleAlerts:` — re-resolved each call from
/// MENU_REF so we never store a raw item pointer. Main-thread-only (NSMenu
/// mutation), so hopped via `run_on_main_thread`.
#[cfg(target_os = "macos")]
fn set_alerts_menu_checkmark(app: &tauri::AppHandle, enabled: bool) {
    let _ = app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        if MainThreadMarker::new().is_none() {
            return;
        }
        let Some(menu) = MENU_REF
            .get()
            .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
        else {
            return;
        };
        let count = menu.numberOfItems();
        let toggle_sel = objc2::sel!(menuToggleAlerts:);
        for i in 0..count {
            let Some(item) = menu.itemAtIndex(i) else {
                continue;
            };
            if item.action() == Some(toggle_sel) {
                let state = if enabled {
                    objc2_app_kit::NSControlStateValueOn
                } else {
                    objc2_app_kit::NSControlStateValueOff
                };
                item.setState(state);
                break;
            }
        }
    });
}

/// One-shot reconcile of the Alerts checkmark to the real `alerts.enabled`
/// after the sidecar binds its port. Spawned from `init` beside the title
/// poller; retries until the port is known, reads GET /api/config once, sets
/// the checkmark, and exits.
#[cfg(target_os = "macos")]
fn seed_alerts_menu_state(app: tauri::AppHandle) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            let port = app
                .try_state::<crate::ipc::AppState>()
                .and_then(|s| s.server_port.lock().ok().and_then(|g| *g));
            let Some(port) = port else { continue };
            let url = format!("http://127.0.0.1:{port}/api/config");
            match crate::http_client::LOCAL_CLIENT.get(&url).send().await {
                Ok(resp) => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        // GET /api/config nests prefs as
                        // `alerts: { alertsEnabled, types }` (config-store.js
                        // effectiveAlertPrefs), NOT `alerts.enabled`. Mirror the
                        // POST path's `alertsEnabled` key so the seed reads the
                        // real persisted state instead of always defaulting on.
                        let enabled = json
                            .get("alerts")
                            .and_then(|a| a.get("alertsEnabled"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(true);
                        set_alerts_menu_checkmark(&app, enabled);
                    }
                    return; // one-shot: succeeded (or got a parseable response)
                }
                Err(e) => {
                    log::debug!("alerts seed: config fetch failed: {e}");
                    // keep retrying until the sidecar answers
                }
            }
        }
    });
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

    let popover = match POPOVER_REF
        .get()
        .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
    {
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

        // Re-show the loading overlay + trigger a fresh /api/* refresh on every
        // open. Without this, the popover hydrates while hidden during app
        // boot — by the user's first click the spinner has long since faded
        // and they only see the static shell while data fetches. The popover
        // JS show-loading listener un-hides the overlay then refresh()es.
        if let Some(webview) = WEBVIEW_REF
            .get()
            .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
        {
            use objc2_foundation::NSString;
            let js = NSString::from_str("window.dispatchEvent(new CustomEvent('show-loading'))");
            unsafe {
                webview.evaluateJavaScript_completionHandler(&js, None);
            }
        }
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
    use objc2_app_kit::{
        NSPopoverBehavior, NSViewController, NSVisualEffectBlendingMode, NSVisualEffectMaterial,
        NSVisualEffectState, NSVisualEffectView,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSURLRequest, NSURL};
    use objc2_web_kit::WKWebViewConfiguration;

    let frame = NSRect {
        origin: NSPoint { x: 0.0, y: 0.0 },
        size: NSSize {
            width: POPOVER_WIDTH,
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

    let webview: Retained<WKWebView> =
        unsafe { WKWebView::initWithFrame_configuration(mtm.alloc::<WKWebView>(), frame, &config) };

    // Enable WebInspector for the popover (macOS 13.3+). Defaults to false on
    // newer macOS — without this, right-click → Inspect Element is unavailable
    // and JS load errors are completely silent. Enabling it adds no overhead
    // and is the only practical way to diagnose popover JS failures in the
    // field. Tauri 2 enables this automatically for its own WebviewWindows
    // via the `devtools` feature, but our native NSPopover WKWebView is
    // constructed directly and needs the explicit setter.
    unsafe { webview.setInspectable(true) };

    // Make every layer involved in the WKWebView stack transparent so the
    // NSVisualEffectView (HudWindow material — same as the dashboard window)
    // we install below actually shows through:
    //
    //   1. setUnderPageBackgroundColor: clearColor — clears the over/under-
    //      scroll fill the WebView paints when content doesn't reach an edge.
    //   2. setValue: NO forKey: "drawsBackground" — undocumented but stable
    //      KVC path on WKWebView (used by Slack, Linear, etc.). Stops the
    //      WebView from painting its own opaque background before the page
    //      renders. Documented public alternative landed in macOS 14.x but
    //      we still target 12.0+ per tauri.conf.json minimumSystemVersion.
    //   3. setWantsLayer + clear layer background — makes the host NSView
    //      composite transparently with the parent visual-effect view.
    //
    // Without all three, the popover stack is: dark NSPopover chrome ->
    // opaque WKWebView host -> page (CSS at any alpha doesn't matter
    // because the WKWebView's own fill blocks the vibrancy material).
    unsafe {
        use objc2::runtime::Bool;
        use objc2_app_kit::NSColor;
        use objc2_foundation::NSNumber;
        let clear = NSColor::clearColor();
        let _: () = objc2::msg_send![&*webview, setUnderPageBackgroundColor: &*clear];
        // KVC path: WKWebView honors `drawsBackground = NO` (Slack / Linear /
        // Notion use this trick on macOS 12-13). 14+ added a public setter
        // but we still target 12.0+.
        let no: Retained<NSNumber> = NSNumber::new_bool(false);
        let key = NSString::from_str("drawsBackground");
        let _: () = objc2::msg_send![&*webview, setValue: &*no, forKey: &*key];
        let _: () = objc2::msg_send![&*webview, setWantsLayer: true];
        if let Some(layer) = webview.layer() {
            let cg_clear: *mut std::ffi::c_void = objc2::msg_send![&*clear, CGColor];
            let _: () = objc2::msg_send![&*layer, setBackgroundColor: cg_clear];
            let _: () = objc2::msg_send![&*layer, setOpaque: Bool::NO];
        }
    }

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

    // v0.9.4 attempt #2: wrap the WKWebView in an NSVisualEffectView. The
    // first attempt looked DARKER than the dashboard because we left
    // WKWebView opaque — its host NSView was drawing on top of the effect
    // view. With drawsBackground=NO + setOpaque(false) + clear layer
    // backgroundColor above, the WKWebView is now fully transparent and
    // the effect view's vibrancy material shows through correctly.
    // BehindWindow blending mode pulls the wallpaper behind the NSPopover
    // window through.
    //
    // v0.9.10: material switched HUDWindow → Popover. HUDWindow is
    // Apple's material for floating utility palettes, with more
    // aggressive continuous compositing of the wallpaper behind. Popover
    // is the material Apple ships specifically for NSPopover content,
    // with a less dynamic compositor. Reduces (though doesn't fully
    // eliminate) the slight repaint flicker on the 10 s auto-refresh
    // cycle that's inherent to a transparent WKWebView CALayer being
    // re-blended onto a vibrancy backdrop on each DOM update.
    let effect_view = NSVisualEffectView::initWithFrame(mtm.alloc(), frame);
    effect_view.setMaterial(NSVisualEffectMaterial::Popover);
    effect_view.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    effect_view.setState(NSVisualEffectState::Active);
    effect_view.addSubview(&webview);
    unsafe {
        // Autoresizing bitmask: width-flex (2) | height-flex (16) = 18.
        let _: () = objc2::msg_send![&*webview, setAutoresizingMask: 18u64];
    }

    let vc = NSViewController::new(mtm);
    vc.setView(&effect_view);

    // v0.9.2: switched from ApplicationDefined → Transient to match the
    // macOS menu-bar convention every other menu-bar app uses (system
    // Wi-Fi/Battery popovers, CodexBar, etc.) — popover dismisses on
    // outside click or app deactivation. v0.7.x..v0.9.1 used
    // ApplicationDefined ("sticky" — only the tray icon dismissed it),
    // which was a deliberate but surprising choice for users coming from
    // other menu-bar apps. Reverting to convention now that the v3
    // foundation has stabilised. Animations stay off so size changes
    // (Task 10) don't flicker.
    let popover = NSPopover::new(mtm);
    popover.setContentViewController(Some(&vc));
    popover.setBehavior(NSPopoverBehavior::Transient);
    popover.setAnimates(false);
    popover.setContentSize(NSSize {
        width: POPOVER_WIDTH,
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
            let mask =
                objc2_app_kit::NSEventMask::LeftMouseUp | objc2_app_kit::NSEventMask::RightMouseUp;
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

    log::info!(
        "native_popover: NSStatusItem + NSPopover created (port={})",
        port
    );

    spawn_tray_title_poller(app.clone());
    seed_alerts_menu_state(app.clone());

    Ok(())
}

/// The 80% "approaching" threshold for the menu-bar ⚠ cue. Mirrors
/// `APPROACHING_LEVELS` (the 80 floor) in `lib/alert-engine.js`.
#[cfg(target_os = "macos")]
const TRAY_WARN_PCT: f64 = 80.0;

/// Pure: returns the warning glyph (`"⚠"`) when EITHER watched window is at or
/// past 80%, else `""`. `None` (window absent / no data) is treated as
/// below-threshold. The caller's format string owns the space before the
/// percent chiclet, so this returns the bare glyph (no trailing space).
/// Unit-tested; the poller that calls it is manual-smoke (landmine #9).
#[cfg(target_os = "macos")]
fn tray_warning_prefix(five_pct: Option<f64>, seven_pct: Option<f64>) -> &'static str {
    let hot = |p: Option<f64>| p.map(|v| v >= TRAY_WARN_PCT).unwrap_or(false);
    if hot(five_pct) || hot(seven_pct) {
        "\u{26a0}" // ⚠
    } else {
        ""
    }
}

/// Background poll: every 30s, fetch /api/usage and write the 5-hour pct as
/// a chiclet on the NSStatusBarButton title (e.g. " 42%"). Migrated from
/// tray.rs so the new NSStatusItem (not the legacy Tauri tray) gets the
/// update during the side-by-side rollout.
#[cfg(target_os = "macos")]
fn spawn_tray_title_poller(app_handle: tauri::AppHandle) {
    use tauri::Manager;

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
            let plan = match crate::http_client::LOCAL_CLIENT.get(&url).send().await {
                Ok(resp) => match resp.json::<serde_json::Value>().await {
                    Ok(json) => json.get("plan").cloned(),
                    Err(e) => {
                        log::debug!("usage json parse failed: {}", e);
                        None
                    }
                },
                Err(e) => {
                    log::debug!("usage fetch failed: {}", e);
                    None
                }
            };
            let window_pct = |plan: &serde_json::Value, window: &str| {
                plan.get(window)
                    .and_then(|w| w.get("pct"))
                    .and_then(|p| p.as_f64())
            };
            if let Some(plan) = plan {
                let five_pct = window_pct(&plan, "fiveHour");
                let seven_pct = window_pct(&plan, "sevenDay");
                if let Some(pct) = five_pct {
                    // PRESERVE the leading-space chiclet gap; the bare ⚠ glyph
                    // (if any) sits BEFORE the space-padded percent. Empty prefix
                    // yields " 42%" (the original shape); warning yields "⚠ 42%".
                    let prefix = tray_warning_prefix(five_pct, seven_pct);
                    let title = format!("{} {}%", prefix, pct.round() as i64);
                    update_tray_title(&app_handle, title);
                }
            }
        }
    });
}

/// Write `title` onto the NSStatusBarButton. setTitle is main-thread-only,
/// so we hop via `run_on_main_thread` from the Tokio worker (mirrors the
/// pattern in `reload_for_port`).
#[cfg(target_os = "macos")]
fn update_tray_title(app: &tauri::AppHandle, title: String) {
    let _ = app.run_on_main_thread(move || {
        use objc2::MainThreadMarker;
        use objc2_foundation::NSString;

        let mtm = match MainThreadMarker::new() {
            Some(m) => m,
            None => return,
        };
        let status_item = match STATUS_ITEM_REF
            .get()
            .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
        {
            Some(s) => s,
            None => return,
        };
        let Some(button) = status_item.button(mtm) else {
            return;
        };
        let ns_title = NSString::from_str(&title);
        button.setTitle(&ns_title);
    });
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
        use objc2_foundation::{NSString, NSURLRequest, NSURL};

        let webview = match WEBVIEW_REF
            .get()
            .and_then(|m| m.lock().ok().and_then(|g| g.as_ref().map(|c| c.get())))
        {
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn warning_prefix_empty_when_both_below_80() {
        assert_eq!(tray_warning_prefix(Some(79.0), Some(50.0)), "");
    }

    #[test]
    fn warning_prefix_set_when_five_hour_at_or_past_80() {
        assert_eq!(tray_warning_prefix(Some(80.0), Some(10.0)), "\u{26a0}");
        assert_eq!(tray_warning_prefix(Some(95.0), None), "\u{26a0}");
        assert_eq!(tray_warning_prefix(Some(100.0), Some(0.0)), "\u{26a0}");
    }

    #[test]
    fn warning_prefix_set_when_seven_day_at_or_past_80() {
        assert_eq!(tray_warning_prefix(Some(10.0), Some(80.0)), "\u{26a0}");
        assert_eq!(tray_warning_prefix(None, Some(99.0)), "\u{26a0}");
    }

    #[test]
    fn warning_prefix_empty_when_both_none() {
        assert_eq!(tray_warning_prefix(None, None), "");
    }

    #[test]
    fn warning_prefix_empty_just_below_threshold() {
        // 79.99 is below 80 — no cue. The boundary is inclusive at 80.0.
        assert_eq!(tray_warning_prefix(Some(79.99), Some(79.99)), "");
    }
}
