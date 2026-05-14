//! In-memory cache for the Claude Code OAuth credentials.
//!
//! v0.7.2 lever for the keychain-prompt-every-launch problem. The cache holds
//! the most-recently-read `ClaudeCodeCreds` in memory; `get_or_load` returns
//! the cached value on hit and triggers a fresh keychain read on miss. The
//! Mutex serializes concurrent callers so only ONE keychain read (and one
//! macOS prompt) fires per cache miss, regardless of how many dashboard
//! polls land simultaneously.
//!
//! Cache lifecycle:
//! - Empty at app start
//! - First `get_or_load` reads + caches
//! - Subsequent `get_or_load` calls return cached value (no prompt)
//! - `invalidate()` (called from OAuth 401 caller) clears the cache
//! - `refresh()` (called from the Refresh button + wizard Connect) forces a
//!   fresh read and replaces the cached value
//!
//! Failures (NotFound, AccessDenied) are NOT cached — the next call retries.

use std::sync::Mutex;

use crate::keychain::{read_claude_code_credentials, ClaudeCodeCreds, KeychainError};

type ReaderFn = Box<dyn Fn() -> Result<ClaudeCodeCreds, KeychainError> + Send + Sync>;

pub struct KeychainCache {
    inner: Mutex<Option<ClaudeCodeCreds>>,
    reader: ReaderFn,
}

impl KeychainCache {
    /// Production constructor: reads from the real macOS Keychain.
    pub fn new() -> Self {
        Self::with_reader(Box::new(read_claude_code_credentials))
    }

    /// Test/injection constructor: pass a fake reader closure.
    pub fn with_reader(reader: ReaderFn) -> Self {
        Self {
            inner: Mutex::new(None),
            reader,
        }
    }

    /// Returns cached creds if present; else reads + caches and returns.
    /// First caller on a cold cache reads (triggers macOS prompt if uncached);
    /// subsequent concurrent callers block briefly on the Mutex and return
    /// the cached value once the first caller completes.
    pub fn get_or_load(&self) -> Result<ClaudeCodeCreds, KeychainError> {
        let mut guard = self.inner.lock().map_err(|e| KeychainError::Framework {
            code: 0,
            message: format!("cache lock poisoned: {}", e),
        })?;
        if let Some(creds) = guard.as_ref() {
            return Ok(creds.clone());
        }
        let creds = (self.reader)()?;
        *guard = Some(creds.clone());
        Ok(creds)
    }

    /// Force a fresh read, replacing the cached value.
    /// Triggers macOS prompt. Used by the Refresh button + wizard Connect.
    pub fn refresh(&self) -> Result<ClaudeCodeCreds, KeychainError> {
        let creds = (self.reader)()?;
        match self.inner.lock() {
            Ok(mut guard) => *guard = Some(creds.clone()),
            Err(e) => log::warn!("keychain_cache: lock poisoned on refresh: {}", e),
        }
        Ok(creds)
    }

    /// Clear the cache. Next `get_or_load` triggers a fresh read.
    /// Called from OAuth 401 handler to recover from token rotation.
    pub fn invalidate(&self) {
        match self.inner.lock() {
            Ok(mut guard) => *guard = None,
            Err(e) => log::warn!("keychain_cache: lock poisoned on invalidate: {}", e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::{ClaudeAiOauth, ClaudeCodeCreds};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn sample_creds() -> ClaudeCodeCreds {
        ClaudeCodeCreds {
            claude_ai_oauth: ClaudeAiOauth {
                access_token: "sample-access-token".to_string(),
                refresh_token: Some("sample-refresh-token".to_string()),
                expires_at: Some(1_900_000_000_000),
                scopes: Some(vec!["user:inference".to_string()]),
                subscription_type: Some("max".to_string()),
                rate_limit_tier: Some("default_claude_max_20x".to_string()),
            },
        }
    }

    fn counting_reader() -> (KeychainCache, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let count_for_closure = count.clone();
        let cache = KeychainCache::with_reader(Box::new(move || {
            count_for_closure.fetch_add(1, Ordering::SeqCst);
            Ok(sample_creds())
        }));
        (cache, count)
    }

    #[test]
    fn cache_miss_reads_and_caches() {
        let (cache, count) = counting_reader();
        let creds = cache.get_or_load().expect("read should succeed");
        assert_eq!(count.load(Ordering::SeqCst), 1, "reader called once on miss");
        assert_eq!(creds.claude_ai_oauth.access_token, "sample-access-token");
    }

    #[test]
    fn cache_hit_returns_cached_without_re_read() {
        let (cache, count) = counting_reader();
        let _ = cache.get_or_load().unwrap();
        let _ = cache.get_or_load().unwrap();
        let _ = cache.get_or_load().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1, "subsequent calls hit cache");
    }

    #[test]
    fn refresh_forces_re_read() {
        let (cache, count) = counting_reader();
        let _ = cache.get_or_load().unwrap();
        let _ = cache.refresh().unwrap();
        let _ = cache.refresh().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 3, "each refresh re-reads");
    }

    #[test]
    fn invalidate_then_get_or_load_re_reads() {
        let (cache, count) = counting_reader();
        let _ = cache.get_or_load().unwrap();
        cache.invalidate();
        let _ = cache.get_or_load().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 2, "post-invalidate triggers read");
    }

    #[test]
    fn read_failure_is_not_cached() {
        // Reader returns NotFound on every call.
        let count = Arc::new(AtomicUsize::new(0));
        let count_for_closure = count.clone();
        let cache = KeychainCache::with_reader(Box::new(move || {
            count_for_closure.fetch_add(1, Ordering::SeqCst);
            Err(KeychainError::NotFound)
        }));

        assert!(cache.get_or_load().is_err());
        assert!(cache.get_or_load().is_err());
        // BOTH calls hit the reader because failures are not cached.
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
}
