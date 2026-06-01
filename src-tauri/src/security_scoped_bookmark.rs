//! macOS security-scoped bookmark wrapper for MAS-flavor Clauge.
//!
//! Apple's App Sandbox forbids reading another app's data folder
//! (~/.claude/, written by Claude Code CLI) without an explicit user grant
//! via the user-selected file entitlement family. This module wraps NSURL's
//! bookmark APIs (via objc2-foundation 0.3.2) to:
//!   1. Prompt the user via NSOpenPanel (via Tauri's dialog plugin) and
//!      capture the chosen folder URL.
//!   2. Persist a security-scoped bookmark blob to the Tauri store under
//!      `settings.json` key `claude_dir_bookmark`.
//!   3. On subsequent launches, resolve the blob → `NSURL` → start the
//!      security scope → return the resolved POSIX path plus an RAII guard
//!      whose `Drop` impl stops the scope.
//!
//! Module is cfg-gated to `feature = "mas"`. Not compiled into DMG/NSIS
//! builds — the DMG flavor reads ~/.claude/ directly without sandbox
//! constraints.
//!
//! Lifecycle note: the SEA sidecar (Node.js child process) inherits the
//! parent's process-tree-scoped sandbox grant for its full lifetime. The
//! supervisor in `sidecar.rs` (Task 6) owns the `ScopedHandle` returned by
//! `acquire_scoped_path` and holds it alive for as long as the sidecar
//! runs — dropping the handle prematurely revokes the child's filesystem
//! access mid-read and surfaces as ENOENT/EPERM in the sidecar logs.

#![cfg(feature = "mas")]

use std::path::PathBuf;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{
    NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
};

/// Process-wide cache for the resolved ~/.claude/ path.
///
/// Populated by `sidecar::spawn_and_supervise` on supervisor start (Task 6)
/// once `acquire_scoped_path` successfully resolves the persisted bookmark.
/// Read by `keychain::read_claude_code_credentials`'s MAS-Mac branch (Task 6)
/// so the credentials reader can locate `.credentials.json` without needing
/// a `&AppHandle` in its signature — preserves the
/// `keychain_cache::ReaderFn` zero-arg closure type (`type ReaderFn =
/// Box<dyn Fn() -> Result<...> + Send + Sync>`) intact.
///
/// Lives in this module because the bookmark resolution is the only thing
/// that *knows* the resolved path; other modules (keychain.rs) only need
/// read access after the supervisor has resolved it.
pub static MAS_CLAUDE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Process-wide holder for the `ScopedHandle` when the IPC layer acquires the
/// scope (vs the supervisor at startup).
///
/// **Why this exists (Task 12b — first-launch UX fix):** the supervisor
/// (Task 6) acquires the scope ONCE at startup via a function-local guard
/// binding. On first launch (fresh sandbox container, no bookmark yet),
/// `acquire_scoped_path` fails, `MAS_CLAUDE_DIR` stays None, and the sidecar
/// spawns with no `CLAUDE_DIR` env. When the user later clicks Grant Access
/// in the wizard, `grant_claude_dir_access` IPC persists the bookmark AND
/// re-acquires the scope to populate `MAS_CLAUDE_DIR` immediately — without
/// requiring an app restart. But the IPC handler's stack frame ends before
/// the user's session does, so we can't hold the `ScopedHandle` in a local;
/// we MUST store it in something with `'static` lifetime, or the Drop impl
/// would fire and revoke filesystem access mid-session.
///
/// `MAS_SCOPE_HOLDER` is that `'static` slot. On first-launch grant, the
/// IPC populates it. On subsequent launches (bookmark already in store),
/// the supervisor's own `_mas_scope_guard` local holds the scope and this
/// slot stays None this run — no conflict because both bindings would
/// resolve to the same NSURL.
///
/// `Mutex::new(None)` is `const` in stable Rust since 1.63 (Cargo.toml's
/// `rust-version = "1.77.2"` is comfortably above), so this works as a
/// `static` initializer without needing `OnceLock` or `lazy_static`.
pub static MAS_SCOPE_HOLDER: std::sync::Mutex<Option<ScopedHandle>> = std::sync::Mutex::new(None);

/// Tauri store key for the persisted bookmark blob.
///
/// Stored as a JSON array of bytes (8x bloat vs base64, but avoids pulling
/// in a base64 dep; bookmark blobs are ~200-300 bytes so the size cost is
/// negligible).
const BOOKMARK_STORE_KEY: &str = "claude_dir_bookmark";

#[derive(Debug, thiserror::Error)]
pub enum BookmarkError {
    /// No bookmark blob exists in the store. The user hasn't granted folder
    /// access yet — the onboarding wizard's grant step (Task 10) should run.
    #[error("no bookmark blob in store — user hasn't granted folder access yet")]
    NoBookmark,

    /// The blob exists but couldn't be turned back into a usable NSURL. This
    /// covers: blob is a JSON array but contents are corrupted (values > 255
    /// or non-numeric), NSURL bookmarkData resolution failed inside Cocoa
    /// (folder moved/deleted, sandbox context rotated, blob format invalid),
    /// or `is_stale=true` was set after resolution. Callers should treat as
    /// "re-prompt the user via `prompt_for_folder_grant`".
    #[error("bookmark blob resolution failed: {0}")]
    Resolution(String),

    /// `startAccessingSecurityScopedResource` returned `false` — the sandbox
    /// declined to honor the bookmark even though resolution succeeded. Rare;
    /// usually indicates a sandbox runtime issue (sandbox profile rotated, or
    /// the bundle's entitlement set has drifted from the bundle that issued
    /// the bookmark). Recovery is the same as `Resolution`: re-prompt.
    #[error("startAccessingSecurityScopedResource returned false")]
    ScopeStart,

    /// The user dismissed the NSOpenPanel without selecting a folder. Not an
    /// error per se — the wizard's grant step should let them retry rather
    /// than surface this as a failure dialog.
    #[error("NSOpenPanel returned no selection (user cancelled)")]
    UserCancelled,

    /// Tauri store I/O failed (couldn't open settings.json, couldn't write,
    /// couldn't read). Distinguishable from `NoBookmark` so the wizard can
    /// offer "Reset access" rather than re-prompting in a loop on a
    /// persistent disk error.
    #[error("tauri store error: {0}")]
    Store(String),
}

/// Long-lived security-scope handle. While alive, the resolved `NSURL` has
/// had `startAccessingSecurityScopedResource` called on it — i.e. the
/// sandbox grants read access to that folder and its descendants. On
/// `Drop`, the scope is released via `stopAccessingSecurityScopedResource`.
///
/// **Why this exists separately from a closure-scoped helper**: the SEA
/// sidecar process needs filesystem access for its FULL lifetime (it tails
/// JSONL files on demand from /api/* requests). macOS security scoping is
/// process-tree-scoped — if the parent calls `stop` while a child is
/// reading, the child loses access too. A closure-scoped guarantee can only
/// sustain access for the duration of the closure body, which is fine for
/// synchronous reads but inadequate for "spawn child, hand off, let child
/// read on its own schedule" patterns. `ScopedHandle` lets the caller own
/// that lifetime explicitly.
///
/// Hold this guard somewhere it lives for as long as the sidecar process
/// is running (e.g. a function-local in `spawn_and_supervise`). `Send +
/// Sync` because `Retained<NSURL>` is `Send + Sync` — NSURL is marked
/// thread-safe in objc2-foundation 0.3.2's generated bindings.
pub struct ScopedHandle {
    url: Retained<NSURL>,
}

impl Drop for ScopedHandle {
    fn drop(&mut self) {
        // SAFETY: `Retained<NSURL>` keeps `url` alive via ARC, so the
        // receiver is still a valid Objective-C object.
        // `stopAccessingSecurityScopedResource` is documented as safe to
        // call multiple times and on URLs that don't have an active scope
        // (it just no-ops), so even a double-drop-style call here can't UB.
        unsafe { self.url.stopAccessingSecurityScopedResource() };
    }
}

/// Show NSOpenPanel; user picks a folder; capture NSURL → bookmark blob → persist.
///
/// This function is **synchronous** and blocks the calling thread until the
/// user picks a folder or cancels. Tauri IPC handlers calling this from an
/// async context MUST wrap the call in
/// `tauri::async_runtime::spawn_blocking(move || ...)` to avoid blocking
/// the tokio worker thread pool. The wizard `#[tauri::command]` handler
/// added in Task 7 follows that pattern.
///
/// Errors:
/// - `UserCancelled` if the user dismisses the panel.
/// - `Resolution` if NSURL bookmark generation fails (Cocoa-level error
///   surfaced as a string).
/// - `Store` if the Tauri store write fails.
pub fn prompt_for_folder_grant(app: &tauri::AppHandle) -> Result<(), BookmarkError> {
    use tauri_plugin_dialog::DialogExt;

    // Pre-select $HOME/.claude/ so the user sees the folder they're most
    // likely to grant. `home_default_claude_dir` returns `None` rather than
    // falling back to "/" because grant-too-broad is an App Review red flag —
    // better to open at the panel's system default than tempt root grants.
    let mut builder = app
        .dialog()
        .file()
        .set_title("Choose your Claude Code data folder");
    if let Some(dir) = home_default_claude_dir() {
        builder = builder.set_directory(dir);
    }
    // `tauri_plugin_dialog::FilePath` is an enum `{ Url, Path }`; for a
    // folder picker on macOS desktop it's always `Path`, but we go through
    // `into_path()` to be safe against the (impossible-on-desktop) Url
    // branch.
    let folder = builder
        .blocking_pick_folder()
        .ok_or(BookmarkError::UserCancelled)?;

    let path_buf = folder
        .into_path()
        .map_err(|e| BookmarkError::Resolution(format!("FilePath::into_path failed: {}", e)))?;
    // macOS paths are UTF-8 in practice; refuse non-UTF-8 rather than
    // silently substituting U+FFFD via to_string_lossy (which would corrupt
    // the bookmark we're about to hand to NSURL).
    let path_str = path_buf
        .to_str()
        .ok_or_else(|| BookmarkError::Resolution("path is not valid UTF-8".into()))?
        .to_owned();

    // NSURL::fileURLWithPath is a safe class method; NSString::from_str is safe.
    let ns_path = NSString::from_str(&path_str);
    let nsurl = NSURL::fileURLWithPath(&ns_path);

    // objc2-foundation 0.3.2 surfaces this as `Result<Retained<NSData>,
    // Retained<NSError>>` — no out-error parameter; the binding wraps the
    // Cocoa convention for us. `WithSecurityScope` is THE flag that turns a
    // plain bookmark into a security-scoped one (renewable across launches).
    let bookmark_data = nsurl
        .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope,
            None,
            None,
        )
        .map_err(|err| {
            log::warn!("NSURL bookmarkDataWithOptions failed: {}", err);
            BookmarkError::Resolution(format!("bookmark create failed: {}", err))
        })?;

    // `to_vec()` is the safe accessor — copies the NSData buffer into a
    // Rust `Vec<u8>`. Avoids the raw pointer alternative.
    let bytes: Vec<u8> = bookmark_data.to_vec();

    persist_bookmark_blob(app, &bytes)?;

    Ok(())
}

/// Resolve the persisted bookmark and START the security scope. Returns the
/// resolved POSIX path plus a guard whose `Drop` impl releases the scope.
///
/// **Lifecycle contract**: callers MUST keep the returned `ScopedHandle`
/// alive for as long as filesystem access to the resolved path is needed.
/// Dropping the handle while a child process (e.g. the SEA sidecar) is
/// still reading from the path will revoke that child's access mid-read,
/// surfacing as ENOENT/EPERM in the child's syscall return.
///
/// Errors:
/// - `NoBookmark` if no blob is persisted (caller should run
///   `prompt_for_folder_grant`).
/// - `Resolution` if the blob is corrupted OR NSURL resolution failed OR
///   the bookmark was reported stale.
/// - `ScopeStart` if `startAccessingSecurityScopedResource` returned false.
/// - `Store` if the Tauri store read fails.
pub fn acquire_scoped_path(
    app: &tauri::AppHandle,
) -> Result<(String, ScopedHandle), BookmarkError> {
    let bytes = read_bookmark_blob(app)?;
    let nsdata = NSData::with_bytes(&bytes);
    // `Bool` is `objc2::runtime::Bool` — Cocoa's BOOL type. Resolution
    // writes through this pointer if the binding determines the bookmark
    // is stale (folder moved on disk but bookmark blob still resolves via
    // fileID).
    let mut is_stale = Bool::new(false);

    // SAFETY: `is_stale` is a stack-allocated `Bool` whose address remains
    // valid for the duration of the unsafe block; the binding requires
    // either a valid `*mut Bool` or null and we pass a valid reference.
    // `nsdata` is a valid `Retained<NSData>` per objc2's reference-counting
    // invariants (constructed via the safe `NSData::with_bytes` above).
    // The `relative_to` argument is `None`, matching the binding's
    // `Option<&NSURL>` signature. `URLByResolvingBookmarkData_*` returns
    // `Result<Retained<NSURL>, Retained<NSError>>` — the binding handles
    // the raw out-pointer null-check for the URL itself, so we only need
    // to keep the `is_stale` borrow alive across the call.
    let url = unsafe {
        NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
            &nsdata,
            NSURLBookmarkResolutionOptions::WithSecurityScope,
            None,
            &mut is_stale,
        )
        .map_err(|err| {
            log::warn!("NSURL URLByResolvingBookmarkData failed: {}", err);
            BookmarkError::Resolution(format!("bookmark resolve failed: {}", err))
        })?
    };

    if is_stale.as_bool() {
        // Per the v0.9.0 plan: log a warning but proceed best-effort. The
        // bookmark may still resolve to a working path (folder moved on
        // disk but reachable via fileID). If subsequent reads fail, the
        // user should re-grant via Settings → Connections. Tri-state UX
        // (stale-but-usable vs stale-and-broken) is deferred to v0.9.1.
        log::warn!(
            "security-scoped bookmark resolved as stale; proceeding best-effort. \
             If reads fail, the user should re-grant via Settings → Connections."
        );
    }

    // SAFETY: `url` is a valid `Retained<NSURL>` returned by the resolve
    // call above; the binding for `startAccessingSecurityScopedResource`
    // requires a live NSURL receiver, satisfied by ARC keeping `url`
    // alive until end of scope. Returns a plain `bool` — no pointer
    // unsafety to manage.
    let started = unsafe { url.startAccessingSecurityScopedResource() };
    if !started {
        log::warn!("startAccessingSecurityScopedResource returned false for resolved bookmark");
        return Err(BookmarkError::ScopeStart);
    }

    // `url.path()` is a safe binding (no `unsafe` decoration in
    // objc2-foundation 0.3.2). Returns `Option<Retained<NSString>>`.
    let path_ns = match url.path() {
        Some(p) => p,
        None => {
            log::warn!("scope started but NSURL.path() returned None; stopping defensively");
            // Defensive: release the scope grant before bailing out. We
            // can't construct a `ScopedHandle` to do this via `Drop`
            // because that's what we'd be returning on success, so call
            // `stop` directly here.
            //
            // SAFETY: same surface as the Drop impl — the URL is still
            // alive via the local `url` binding's `Retained` reference.
            unsafe { url.stopAccessingSecurityScopedResource() };
            return Err(BookmarkError::Resolution(
                "resolved NSURL has no POSIX path".into(),
            ));
        }
    };
    let path_str = path_ns.to_string();

    Ok((path_str, ScopedHandle { url }))
}

/// Returns `true` if a bookmark blob is present in the store. Cheap (no
/// Cocoa FFI; just a Tauri store lookup). Used by the onboarding wizard to
/// decide whether to show the grant step.
pub fn has_bookmark(app: &tauri::AppHandle) -> bool {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store("settings.json") else {
        return false;
    };
    store.get(BOOKMARK_STORE_KEY).is_some()
}

/// Remove the persisted bookmark from the store. Used by a future "Reset
/// access" / "Re-select folder" button in the Settings pane (Task 10).
///
/// Does NOT call `stopAccessingSecurityScopedResource` — that's the
/// `ScopedHandle::drop` responsibility for handles already in flight.
/// Clearing the blob only affects FUTURE `acquire_scoped_path` calls.
pub fn clear_bookmark(app: &tauri::AppHandle) -> Result<(), BookmarkError> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store("settings.json")
        .map_err(|e| BookmarkError::Store(e.to_string()))?;
    store.delete(BOOKMARK_STORE_KEY);
    store
        .save()
        .map_err(|e| BookmarkError::Store(e.to_string()))?;
    Ok(())
}

// -----------------------------------------------------------------------------
// Internal helpers (not pub) — store I/O and path defaulting
// -----------------------------------------------------------------------------

/// Default starting directory for the NSOpenPanel — resolves to `$HOME/.claude`.
///
/// Returns `None` if `$HOME` is unset (pathological in a sandbox runtime)
/// so the panel opens at the system default rather than tempting the user
/// to grant filesystem-root access — Apple's App Review flags
/// scope-too-broad grants.
///
/// Pre-selects `~/.claude` (the PARENT, not `~/.claude/projects`) because
/// the MAS flavor needs read access to both `.credentials.json` (for the
/// keychain reader's MAS branch) AND `projects/` (for the sidecar's JSONL
/// tailer). Granting `~/.claude` covers both with a single user gesture.
fn home_default_claude_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".claude"))
}

/// Read the bookmark blob from the Tauri store, decoding the JSON byte
/// array back to a `Vec<u8>`. Fails with `NoBookmark` if the entry is
/// missing (the wizard should call `prompt_for_folder_grant`); fails with
/// `Store` if the entry exists but is malformed (distinguishable so the
/// wizard can offer "Reset access" rather than loop on the same blob).
fn read_bookmark_blob(app: &tauri::AppHandle) -> Result<Vec<u8>, BookmarkError> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store("settings.json")
        .map_err(|e| BookmarkError::Store(e.to_string()))?;
    let blob = store
        .get(BOOKMARK_STORE_KEY)
        .ok_or(BookmarkError::NoBookmark)?;
    let arr = blob
        .as_array()
        .ok_or_else(|| BookmarkError::Store("bookmark blob is not a JSON array".into()))?;
    arr.iter()
        .map(|v| {
            v.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or_else(|| BookmarkError::Store("bookmark blob corrupted".into()))
        })
        .collect()
}

/// Write the bookmark blob to the Tauri store as a JSON byte array.
fn persist_bookmark_blob(app: &tauri::AppHandle, bytes: &[u8]) -> Result<(), BookmarkError> {
    use tauri_plugin_store::StoreExt;
    let store = app
        .store("settings.json")
        .map_err(|e| BookmarkError::Store(e.to_string()))?;
    let json_array: Vec<serde_json::Value> = bytes
        .iter()
        .map(|b| serde_json::Value::Number((*b).into()))
        .collect();
    store.set(BOOKMARK_STORE_KEY, serde_json::Value::Array(json_array));
    store
        .save()
        .map_err(|e| BookmarkError::Store(e.to_string()))?;
    Ok(())
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
//
// The Cocoa-touching paths (`prompt_for_folder_grant`, `acquire_scoped_path`)
// need a real NSOpenPanel + real Cocoa runtime — can't be unit-tested in CI
// headless. They're covered by the Task 12 manual smoke matrix.
//
// `home_default_claude_dir` is a pure env-var resolver that we CAN test
// without any Tauri or Cocoa surface — exercises both the present-and-set
// and absent branches via env::set_var / env::remove_var. We use serial_test
// because env mutations from parallel tests race.
//
// `has_bookmark`, `clear_bookmark`, and the read/persist helpers need an
// `AppHandle` to construct a Tauri store. Tauri's `MockRuntime` exists but
// doesn't currently support the store plugin's setup() hook, so those paths
// rely on the Task 12 smoke matrix too. Leaving them un-tested here is a
// known gap, documented in the spec's §Step 5.5 fallback clause.

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    #[serial]
    fn home_default_returns_some_when_home_set() {
        // Save and restore so the test doesn't leak state to its peers.
        let prev = std::env::var("HOME").ok();
        std::env::set_var("HOME", "/Users/testuser");
        let got = home_default_claude_dir();
        assert_eq!(got, Some(PathBuf::from("/Users/testuser/.claude")));
        // Restore.
        match prev {
            Some(p) => std::env::set_var("HOME", p),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    #[serial]
    fn home_default_returns_none_when_home_unset() {
        // Save and restore so the test doesn't leak state to its peers.
        let prev = std::env::var("HOME").ok();
        std::env::remove_var("HOME");
        let got = home_default_claude_dir();
        assert_eq!(got, None);
        // Restore.
        if let Some(p) = prev {
            std::env::set_var("HOME", p);
        }
    }

    #[test]
    fn bookmark_error_display_strings() {
        // Cheap smoke test that thiserror's #[error] strings are wired up;
        // catches a regression where someone removes the #[error] attribute
        // on a new variant.
        assert_eq!(
            format!("{}", BookmarkError::NoBookmark),
            "no bookmark blob in store — user hasn't granted folder access yet"
        );
        assert_eq!(
            format!("{}", BookmarkError::ScopeStart),
            "startAccessingSecurityScopedResource returned false"
        );
        assert_eq!(
            format!("{}", BookmarkError::UserCancelled),
            "NSOpenPanel returned no selection (user cancelled)"
        );
        assert_eq!(
            format!("{}", BookmarkError::Resolution("xyz".into())),
            "bookmark blob resolution failed: xyz"
        );
        assert_eq!(
            format!("{}", BookmarkError::Store("abc".into())),
            "tauri store error: abc"
        );
    }

    #[test]
    fn scoped_handle_is_send_and_sync() {
        // Compile-only regression guard: if a future objc2-foundation
        // version retracts `Retained<NSURL>: Send + Sync`, this test stops
        // compiling and surfaces the breakage before the supervisor in
        // `sidecar.rs` (which moves a `ScopedHandle` across threads) fails
        // at use-site with a less obvious error.
        fn assert_send<T: Send>() {}
        fn assert_sync<T: Sync>() {}
        assert_send::<ScopedHandle>();
        assert_sync::<ScopedHandle>();
    }

    #[test]
    fn mas_claude_dir_is_initially_unset() {
        // OnceLock starts empty; populated by the supervisor in Task 6 once
        // acquire_scoped_path resolves. This sanity check guards against
        // accidentally giving it a default value in the future (e.g. a
        // `OnceLock::with(...)` call during static init).
        //
        // NOTE: this test must run BEFORE any production code that calls
        // `MAS_CLAUDE_DIR.set(...)`. Within `cargo test --lib --features mas`
        // there's no such code path yet (Task 6 wires it), so the static
        // stays empty for the test's duration.
        assert!(MAS_CLAUDE_DIR.get().is_none());
    }
}
