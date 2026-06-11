//! Coordinated, atomic iCloud snapshot write (Phase ②b, both flavors).
//!
//! The companion iOS app reads a small analytics snapshot from the app's own
//! iCloud Drive container. This module performs the Mac-side write the right
//! way:
//!
//!   * **Coordinated** — via `NSFileCoordinator`, the only mechanism that
//!     serializes our write against iCloud's own uploader (`bird`/
//!     `fileproviderd`). A bare write races the uploader and can publish a torn
//!     file to the device.
//!   * **Atomic** — `NSData writeToURL:atomically:YES` writes to a temp file
//!     then renames, so a reader never observes a half-written file.
//!
//! The PARENT process owns this write (it resolves the container — via the
//! ubiquity API on MAS, or the direct unsandboxed path on DMG — and is the
//! single long-lived process), which structurally avoids the two-writer race a
//! sidecar-owned write would hit during sidecar respawn. The sidecar only
//! assembles the JSON; the parent stamps freshness metadata and calls this.
//!
//! THREADING (AGENTS landmine #36): `NSFileCoordinator` blocks the calling
//! thread on `filecoordinationd`. Callers MUST invoke `write_snapshot_coordinated`
//! inside `tauri::async_runtime::spawn_blocking` — never on the UI/main thread
//! or a bare tokio worker. The accessor block runs synchronously on the calling
//! thread (the binding's `Fn(NonNull<NSURL>) + '_` has no `Send` bound), so the
//! `Cell<bool>` write-result flag captured by the closure is safe.

#![cfg(target_os = "macos")]

use std::cell::Cell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_foundation::{
    NSData, NSError, NSFileCoordinator, NSFileCoordinatorWritingOptions, NSFileManager, NSString,
    NSURL,
};

/// Dotted iCloud container identifier (matches the MAS ubiquity entitlement).
/// Only the MAS resolver below references it — the DMG resolver uses the direct
/// `iCloud~com~clauding~clauge` path component instead — so gate it to `mas`,
/// or clippy's `-D warnings` flags it as dead code in the DMG build.
#[cfg(feature = "mas")]
const ICLOUD_CONTAINER_ID: &str = "iCloud.com.clauding.clauge";

/// Resolve the app's iCloud ubiquity container as a live `NSURL`.
/// MAS / sandboxed: `URLForUbiquityContainerIdentifier` is the ONLY correct source
/// — under the App Sandbox `$HOME` redirects to the container, so a home-derived
/// path would silently dead-write (AGENTS landmine #34). THREADING (landmine #35):
/// may block on first use; call inside spawn_blocking.
#[cfg(feature = "mas")]
pub fn resolve_icloud_container() -> Option<Retained<NSURL>> {
    let fm = NSFileManager::defaultManager();
    let id = NSString::from_str(ICLOUD_CONTAINER_ID);
    fm.URLForUbiquityContainerIdentifier(Some(&id))
}

/// Resolve the iCloud container by direct filesystem path (DMG / un-sandboxed).
/// The ②a spike proved an un-sandboxed app with NO iCloud entitlement can write to
/// `~/Library/Mobile Documents/iCloud~com~clauding~clauge/Documents/` and the OS
/// syncs it. SAFE ONLY because this build is NOT sandboxed; the
/// `#[cfg(not(feature = "mas"))]` gate makes the home-path version uncompilable for
/// MAS, so it can never reintroduce the sandbox dead-write (landmine #34). Returns
/// `None` if `$HOME` is unset or the container dir is absent (iCloud Drive off → skip).
#[cfg(not(feature = "mas"))]
pub fn resolve_icloud_container() -> Option<Retained<NSURL>> {
    let home = std::env::var("HOME").ok()?;
    let container_path = format!("{home}/Library/Mobile Documents/iCloud~com~clauding~clauge");
    if !std::path::Path::new(&container_path).exists() {
        return None;
    }
    Some(NSURL::fileURLWithPath(&NSString::from_str(&container_path)))
}

/// Subdirectory inside the ubiquity container. iCloud Drive surfaces files
/// under `Documents/` to the user and to other devices; the ②a spike proved
/// sync against `Documents/clauge-spike.json`, so ②b reuses this proven subpath.
const DOCUMENTS_SUBDIR: &str = "Documents";

/// The single snapshot file the iPhone reads.
const SNAPSHOT_FILENAME: &str = "clauge-snapshot.json";

/// Write `payload` to `<container>/Documents/clauge-snapshot.json` using a
/// coordinated, atomic write.
///
/// `container_url` MUST be a live `Retained<NSURL>` from
/// `security_scoped_bookmark::resolve_icloud_container` — child paths are built
/// via `URLByAppendingPathComponent` on it (AGENTS landmine #36), never by
/// string-concatenating its percent-decoded `path()`.
///
/// Returns `Err` if EITHER the coordinator surfaces an `NSError` OR the inner
/// atomic write returns `false` (e.g. the `Documents/` dir is missing or the
/// disk is full) — both layers are checked so a failure can never be silent.
pub fn write_snapshot_coordinated(container_url: &NSURL, payload: &[u8]) -> Result<(), String> {
    let fm = NSFileManager::defaultManager();

    // Build child URLs by appending components to the retained container NSURL
    // (landmine #36) — NOT by string concat over the percent-decoded path.
    let docs_dir = container_url
        .URLByAppendingPathComponent(&NSString::from_str(DOCUMENTS_SUBDIR))
        .ok_or_else(|| "failed to build Documents/ URL under iCloud container".to_string())?;
    let target_url = docs_dir
        .URLByAppendingPathComponent(&NSString::from_str(SNAPSHOT_FILENAME))
        .ok_or_else(|| "failed to build snapshot file URL under iCloud container".to_string())?;

    // The ubiquity container does NOT auto-create `Documents/`; writing into a
    // missing dir makes writeToURL:atomically: return false. Create it first
    // (idempotent with withIntermediateDirectories:true).
    //
    // SAFETY: `createDirectoryAtURL...` is marked unsafe only for its generic
    // `attributes` argument; we pass `None`, `docs_dir` is a valid
    // Retained<NSURL>, and create_intermediates:true is documented idempotent.
    unsafe {
        fm.createDirectoryAtURL_withIntermediateDirectories_attributes_error(&docs_dir, true, None)
            .map_err(|e| format!("createDirectory(Documents) failed: {e}"))?;
    }

    let coordinator = NSFileCoordinator::new();

    // The accessor writes to the URL the coordinator hands it (which may differ
    // from `target_url`), inside the coordinated region. It runs synchronously
    // on THIS thread, so a `Cell<bool>` captured by reference safely hoists the
    // inner write result out of the block.
    let wrote = Cell::new(false);
    let payload_owned = payload.to_vec();
    // Borrowing (not `move`) closure: the accessor runs synchronously on this
    // thread and does not escape, so it can borrow `wrote` + `payload_owned`,
    // letting us read `wrote` after the coordinated call returns.
    let accessor = RcBlock::new(|coord_url: NonNull<NSURL>| {
        // SAFETY: the coordinator guarantees `coord_url` points at a valid NSURL
        // for the duration of the accessor call.
        let url = unsafe { coord_url.as_ref() };
        let data = NSData::with_bytes(&payload_owned);
        wrote.set(data.writeToURL_atomically(url, true));
    });

    let mut error: Option<Retained<NSError>> = None;
    coordinator.coordinateWritingItemAtURL_options_error_byAccessor(
        &target_url,
        NSFileCoordinatorWritingOptions::ForReplacing,
        Some(&mut error),
        &accessor,
    );

    // Check BOTH layers (landmine #36): the coordinator's NSError AND the inner
    // atomic-write bool. If the coordinator denied/timed out the accessor never
    // ran and `error` is populated; if it ran but the write failed `wrote`
    // stays false.
    if let Some(e) = error {
        return Err(format!("NSFileCoordinator write failed: {e}"));
    }
    if !wrote.get() {
        return Err(
            "writeToURL:atomically: returned false (Documents/ missing or disk full?)".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DMG resolver returns `None` when the iCloud container dir is absent.
    /// Points `$HOME` at a tempdir with no `Library/Mobile Documents/...`
    /// subtree, so the existence check short-circuits to `None` (the "iCloud
    /// Drive off / not signed in → skip this publish tick" path). `#[serial]`
    /// because it mutates the process-global `$HOME`. Only compiled in the DMG
    /// (non-mas) build, where this resolver variant exists.
    #[cfg(not(feature = "mas"))]
    #[test]
    #[serial_test::serial]
    fn dmg_resolve_returns_none_when_container_absent() {
        let tmp = std::env::temp_dir().join("clauge-no-icloud-test-XYZ");
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", &tmp);
        assert!(resolve_icloud_container().is_none());
        match prev {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
    }

    /// Exercises the REAL coordinated write against the live iCloud container,
    /// run UN-sandboxed. `cargo test` has no iCloud entitlement, so we bypass
    /// `forUbiquityContainerIdentifier` and point at the known container path
    /// directly — the ②a spike proved un-sandboxed writes to this path sync.
    /// This verifies the coordinated-write mechanism end to end (child-URL
    /// append, Documents/ create, NSFileCoordinator + RcBlock accessor, atomic
    /// write, both error layers). `#[ignore]` so CI (sandbox-less, no iCloud)
    /// skips it; run manually on a Mac signed into iCloud:
    ///   cargo test --features mas -- --ignored coordinated_write_lands
    #[test]
    #[ignore = "writes to the real iCloud container; run manually with --ignored on a Mac signed into iCloud"]
    fn coordinated_write_lands_in_real_icloud_container() {
        let home = std::env::var("HOME").expect("HOME is set");
        let container_path = format!("{home}/Library/Mobile Documents/iCloud~com~clauding~clauge");
        let url = NSURL::fileURLWithPath(&NSString::from_str(&container_path));

        let payload =
            br#"{"schemaVersion":1,"seq":99,"writerId":"local-rust-test","summary":{"cost":42.5}}"#;
        write_snapshot_coordinated(&url, payload).expect("coordinated write should succeed");

        let snapshot_path = format!("{container_path}/Documents/clauge-snapshot.json");
        let text = std::fs::read_to_string(&snapshot_path).expect("snapshot file should exist");
        assert!(text.contains("\"seq\":99"), "unexpected content: {text}");
        assert!(text.contains("local-rust-test"));
    }
}
