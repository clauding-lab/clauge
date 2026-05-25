// Tests for lib/config-paths.js — the single source of truth for
// where Clauge keeps state on disk. The shape here is consumed by every
// CLI subcommand, so changes ripple widely.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { configPaths, APP_NAME, BUNDLE_ID } from '../../lib/config-paths.js';

describe('configPaths constants', () => {
  test('APP_NAME matches tauri.conf.json productName', () => {
    assert.equal(APP_NAME, 'Clauge');
  });

  test('BUNDLE_ID matches tauri.conf.json identifier', () => {
    assert.equal(BUNDLE_ID, 'com.clauding.clauge');
  });
});

describe('configPaths.keychainItems', () => {
  test('exposes anthropicOAuth = "Claude Code-credentials"', () => {
    // This is the Keychain Service name written by Claude Code itself.
    // Renaming would break Clauge's read of the user's OAuth blob.
    assert.equal(configPaths.keychainItems.anthropicOAuth, 'Claude Code-credentials');
  });

  test('exposes claudeAiSession = "com.clauding.clauge.claude-ai-session"', () => {
    assert.equal(
      configPaths.keychainItems.claudeAiSession,
      'com.clauding.clauge.claude-ai-session',
    );
  });

  test('exposes trialCounter = "com.clauding.clauge.trial-counter"', () => {
    // Forward-looking — the Keychain item itself is created in task #9
    // (Rust-side Keychain wrappers). Naming is locked here so the JS CLI
    // and Rust shell agree on the item name.
    assert.equal(
      configPaths.keychainItems.trialCounter,
      'com.clauding.clauge.trial-counter',
    );
  });

  test('exposes anthropicAdmin = "com.clauding.clauge.anthropic-admin-key"', () => {
    assert.equal(
      configPaths.keychainItems.anthropicAdmin,
      'com.clauding.clauge.anthropic-admin-key',
    );
  });
});

describe('configPaths macOS paths', { skip: process.platform !== 'darwin' }, () => {
  test('settingsFile() points at the bundleId-keyed Tauri plugin store file', () => {
    // Tauri's plugin_store places settings.json under the bundleIdentifier dir,
    // NOT the productName dir. Verified by ls ~/Library/Application Support/.
    const expected = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      BUNDLE_ID,
      'settings.json',
    );
    assert.equal(configPaths.settingsFile(), expected);
  });

  test('preferencesFile() uses the bundleId-named plist', () => {
    const expected = path.join(
      os.homedir(),
      'Library',
      'Preferences',
      `${BUNDLE_ID}.plist`,
    );
    assert.equal(configPaths.preferencesFile(), expected);
  });

  test('logsDir() uses the productName-keyed Logs dir', () => {
    const expected = path.join(os.homedir(), 'Library', 'Logs', APP_NAME);
    assert.equal(configPaths.logsDir(), expected);
  });

  test('cacheDir() uses the productName-keyed Caches dir', () => {
    const expected = path.join(os.homedir(), 'Library', 'Caches', APP_NAME);
    assert.equal(configPaths.cacheDir(), expected);
  });

  test('portFile() lives inside cacheDir()', () => {
    assert.equal(
      configPaths.portFile(),
      path.join(configPaths.cacheDir(), 'active-port'),
    );
  });
});

describe('configPaths Windows paths', { skip: process.platform !== 'win32' }, () => {
  test('settingsFile() uses %APPDATA% bundleId dir', () => {
    const appdata = process.env.APPDATA;
    if (!appdata) return; // env-dependent, skip if not set
    const expected = path.join(appdata, BUNDLE_ID, 'settings.json');
    assert.equal(configPaths.settingsFile(), expected);
  });

  test('cacheDir() uses %LOCALAPPDATA% productName dir', () => {
    const localappdata = process.env.LOCALAPPDATA;
    if (!localappdata) return;
    const expected = path.join(localappdata, APP_NAME);
    assert.equal(configPaths.cacheDir(), expected);
  });
});

describe('configPaths CLAUGE_HOME override (for tests)', () => {
  test('redirects all paths under CLAUGE_HOME when set', async () => {
    // Import a fresh copy so the env override is read at call time.
    const tmp = path.join(os.tmpdir(), `clauge-paths-test-${process.pid}`);
    const original = process.env.CLAUGE_HOME;
    process.env.CLAUGE_HOME = tmp;
    try {
      // Bust the import cache so we re-evaluate the env at module load.
      const fresh = await import(`../../lib/config-paths.js?t=${Date.now()}`);
      const settings = fresh.configPaths.settingsFile();
      const cache = fresh.configPaths.cacheDir();
      const port = fresh.configPaths.portFile();
      assert.ok(
        settings.startsWith(tmp),
        `settingsFile (${settings}) should start with ${tmp}`,
      );
      assert.ok(cache.startsWith(tmp), `cacheDir should start with ${tmp}`);
      assert.ok(port.startsWith(tmp), `portFile should start with ${tmp}`);
    } finally {
      if (original === undefined) delete process.env.CLAUGE_HOME;
      else process.env.CLAUGE_HOME = original;
    }
  });
});
