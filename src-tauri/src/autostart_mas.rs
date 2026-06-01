//! MAS-flavor launch-at-login via Apple's ServiceManagement `SMAppService`.
//!
//! The DMG/Windows flavors use `tauri-plugin-autostart` (LaunchAgent), which
//! works in a non-sandboxed process. Under the App Sandbox a LaunchAgent plist
//! write is redirected into the app's container
//! (`~/Library/Containers/com.clauding.clauge/Data/Library/LaunchAgents/`) where
//! launchd never scans it — so autostart silently fails AND the onboarding
//! wizard's "added to your login items" claim becomes false. `SMAppService.mainApp`
//! is Apple's sandbox-correct API: it registers the running app itself as a login
//! item that genuinely appears in System Settings → Login Items and is
//! user-toggleable (no separate approval prompt for the main-app case).
//!
//! `SMAppService` is macOS 13.0+. On macOS 12 the class does not exist, so every
//! entry point is guarded by `is_supported()` (a runtime OS-version check) and
//! no-ops there — the app still runs, it just cannot offer launch-at-login. This
//! is why the app's `minimumSystemVersion` stays at 12.0: we degrade the feature,
//! not the whole app.
#![cfg(feature = "mas")]

use objc2_foundation::{NSOperatingSystemVersion, NSProcessInfo};
use objc2_service_management::{SMAppService, SMAppServiceStatus};

/// `SMAppService` requires macOS 13.0+. Guard every call so a macOS 12 launch
/// never messages a class that isn't registered in its Objective-C runtime.
fn is_supported() -> bool {
    let version = NSOperatingSystemVersion {
        majorVersion: 13,
        minorVersion: 0,
        patchVersion: 0,
    };
    // objc2 marks these safe: +[NSProcessInfo processInfo] and
    // -isOperatingSystemAtLeastVersion: are available on every supported macOS.
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(version)
}

/// Register the running app as a login item (visible + toggleable in System
/// Settings → Login Items). Returns an error string on macOS 12 (unsupported)
/// or if registration fails; callers log-and-continue rather than hard-fail.
pub fn enable() -> Result<(), String> {
    if !is_supported() {
        return Err("launch-at-login requires macOS 13 or later".to_string());
    }
    // SAFETY: mainAppService constructs the main-app service object; the
    // -registerAndReturnError: BOOL/NSError** pair maps to Result.
    let service = unsafe { SMAppService::mainAppService() };
    unsafe { service.registerAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
}

/// Unregister the login item. No-op on macOS 12; safe when not registered.
pub fn disable() -> Result<(), String> {
    if !is_supported() {
        return Ok(());
    }
    let service = unsafe { SMAppService::mainAppService() };
    unsafe { service.unregisterAndReturnError() }.map_err(|e| e.localizedDescription().to_string())
}

/// True iff the app is currently registered AND enabled as a login item.
/// Returns false on macOS 12 (feature unavailable).
pub fn is_enabled() -> bool {
    if !is_supported() {
        return false;
    }
    let service = unsafe { SMAppService::mainAppService() };
    let status = unsafe { service.status() };
    status == SMAppServiceStatus::Enabled
}
