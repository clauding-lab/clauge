//! Port-file mechanism so a standalone Node CLI invocation (`clauge
//! config get`, etc.) can find a running Clauge to talk to.
//!
//! The Tauri shell calls `port_file::write(port)` from inside
//! `AppState::set_port` so every port-discovery path (external + spawned
//! sidecar + crash-respawn) updates the file. The shutdown handler in
//! `lib.rs::RunEvent::ExitRequested` calls `port_file::remove()` so a
//! stale port doesn't confuse the next CLI run.
//!
//! Path:
//!   macOS:   ~/Library/Caches/Clauge/active-port
//!   Windows: %LOCALAPPDATA%\Clauge\active-port
//!   Linux:   $XDG_CACHE_HOME/Clauge/active-port (or ~/.cache/Clauge/)
//!
//! Atomicity: write to a sibling `.active-port.tmp`, fsync, rename. A
//! reader observes either the old port or the new port, never a
//! truncated/half-written number.
//!
//! Path agreement: the JS side computes the same path via
//! `lib/config-paths.js::configPaths.portFile()`. Both sides include
//! tests that assert the exact path string — if either drifts, the
//! relevant suite fails loud.

use std::env;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

const APP_NAME: &str = "Clauge";

/// Computes the path where the active port is recorded. Honors
/// CLAUGE_HOME for test isolation (same convention as the JS module).
pub fn path() -> Result<PathBuf, String> {
    Ok(cache_dir()?.join("active-port"))
}

fn cache_dir() -> Result<PathBuf, String> {
    // CLAUGE_HOME override — tests sandbox path resolution under tmpdir.
    if let Ok(home_override) = env::var("CLAUGE_HOME") {
        return Ok(PathBuf::from(home_override)
            .join("Library")
            .join("Caches")
            .join(APP_NAME));
    }

    #[cfg(target_os = "macos")]
    {
        let home = env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
        Ok(PathBuf::from(home)
            .join("Library")
            .join("Caches")
            .join(APP_NAME))
    }
    #[cfg(target_os = "windows")]
    {
        let local = env::var("LOCALAPPDATA").map_err(|e| format!("LOCALAPPDATA not set: {e}"))?;
        Ok(PathBuf::from(local).join(APP_NAME))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let xdg = env::var("XDG_CACHE_HOME")
            .or_else(|_| env::var("HOME").map(|h| format!("{h}/.cache")))
            .map_err(|e| format!("HOME/XDG_CACHE_HOME not set: {e}"))?;
        Ok(PathBuf::from(xdg).join(APP_NAME))
    }
}

/// Atomically write the port to the port file. Creates the parent dir
/// if it doesn't exist.
pub fn write(port: u16) -> Result<(), String> {
    let path = path()?;
    let dir = path
        .parent()
        .ok_or_else(|| format!("port_file path has no parent: {}", path.display()))?;
    fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let tmp = dir.join(".active-port.tmp");
    {
        let mut f =
            fs::File::create(&tmp).map_err(|e| format!("create tmp {}: {e}", tmp.display()))?;
        write!(f, "{}", port).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("sync tmp: {e}"))?;
    }
    fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} → {}: {e}", tmp.display(), path.display()))?;
    Ok(())
}

/// Remove the port file. Returns Ok if the file didn't exist —
/// idempotent so the shutdown handler can call this unconditionally.
pub fn remove() -> Result<(), String> {
    let path = path()?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // Tests mutate CLAUGE_HOME, which is process-wide state. Serialize so
    // parallel test threads don't stomp each other.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let original = env::var(key).ok();
            // SAFETY: tests are serialized via ENV_LOCK above.
            unsafe { env::set_var(key, value) };
            EnvGuard { key, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => unsafe { env::set_var(self.key, v) },
                None => unsafe { env::remove_var(self.key) },
            }
        }
    }

    fn tmpdir() -> PathBuf {
        let base = env::temp_dir();
        let name = format!("clauge-port-file-test-{}", std::process::id());
        let dir = base.join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create tmpdir");
        dir
    }

    #[test]
    fn path_honors_clauge_home_override() {
        let _lock = ENV_LOCK.lock().unwrap();
        let tmp = tmpdir();
        let _guard = EnvGuard::set("CLAUGE_HOME", tmp.to_str().unwrap());
        let p = path().expect("path computes");
        assert!(
            p.starts_with(&tmp),
            "expected path {} to start with tmpdir {}",
            p.display(),
            tmp.display()
        );
        assert_eq!(p.file_name().and_then(|s| s.to_str()), Some("active-port"));
    }

    #[test]
    fn write_then_read_round_trips_port() {
        let _lock = ENV_LOCK.lock().unwrap();
        let tmp = tmpdir();
        let _guard = EnvGuard::set("CLAUGE_HOME", tmp.to_str().unwrap());
        write(34567).expect("write succeeds");
        let p = path().unwrap();
        let contents = fs::read_to_string(&p).expect("file exists after write");
        assert_eq!(contents, "34567");
    }

    #[test]
    fn write_creates_parent_dir() {
        let _lock = ENV_LOCK.lock().unwrap();
        let tmp = tmpdir();
        let _guard = EnvGuard::set("CLAUGE_HOME", tmp.to_str().unwrap());
        // Don't pre-create the cache dir — write() must mkdir -p.
        write(3456).expect("write succeeds even when parent dir is absent");
        let p = path().unwrap();
        assert!(p.exists(), "port file exists after write");
    }

    #[test]
    fn write_overwrites_existing_port() {
        let _lock = ENV_LOCK.lock().unwrap();
        let tmp = tmpdir();
        let _guard = EnvGuard::set("CLAUGE_HOME", tmp.to_str().unwrap());
        write(3456).unwrap();
        write(7890).unwrap();
        let contents = fs::read_to_string(path().unwrap()).unwrap();
        assert_eq!(contents, "7890", "second write replaces first");
    }

    #[test]
    fn remove_is_idempotent_when_file_absent() {
        let _lock = ENV_LOCK.lock().unwrap();
        let tmp = tmpdir();
        let _guard = EnvGuard::set("CLAUGE_HOME", tmp.to_str().unwrap());
        // File doesn't exist yet.
        remove().expect("remove on absent file is Ok");
    }

    #[test]
    fn remove_deletes_existing_port_file() {
        let _lock = ENV_LOCK.lock().unwrap();
        let tmp = tmpdir();
        let _guard = EnvGuard::set("CLAUGE_HOME", tmp.to_str().unwrap());
        write(3456).unwrap();
        let p = path().unwrap();
        assert!(p.exists());
        remove().unwrap();
        assert!(!p.exists(), "port file deleted");
    }

    #[test]
    fn no_tmp_file_left_behind_after_write() {
        let _lock = ENV_LOCK.lock().unwrap();
        let tmp = tmpdir();
        let _guard = EnvGuard::set("CLAUGE_HOME", tmp.to_str().unwrap());
        write(3456).unwrap();
        let dir = path().unwrap().parent().unwrap().to_path_buf();
        let tmp_file = dir.join(".active-port.tmp");
        assert!(!tmp_file.exists(), "the rename should consume the tmp file");
    }
}
