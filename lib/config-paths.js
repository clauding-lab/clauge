// Single source of truth for where Clauge keeps state on disk.
//
// Paths are computed at call time (not at import time) so the
// CLAUGE_HOME test override takes effect immediately when set.
//
// Path conventions follow Tauri's app_data_dir / app_cache_dir, which
// key on the bundle identifier on macOS + Windows. The Tauri plugin_store
// writes to <app_data_dir>/settings.json — that's the file `clauge config
// get` reads when Clauge isn't running.

import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Clauge';
export const BUNDLE_ID = 'com.clauding.clauge';

function homeRoot() {
  // CLAUGE_HOME overrides the per-platform conventions. Used by tests to
  // sandbox path resolution under a tmp dir without touching the user's
  // real Library / AppData. In production this is unset.
  return process.env.CLAUGE_HOME || os.homedir();
}

function appDataDir() {
  const root = homeRoot();
  if (process.env.CLAUGE_HOME) {
    return path.join(root, 'Library', 'Application Support', BUNDLE_ID);
  }
  if (process.platform === 'darwin') {
    return path.join(root, 'Library', 'Application Support', BUNDLE_ID);
  }
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(root, 'AppData', 'Roaming');
    return path.join(appdata, BUNDLE_ID);
  }
  // Linux / others — follow XDG.
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(root, '.config');
  return path.join(xdgConfig, BUNDLE_ID);
}

function cacheDirInternal() {
  const root = homeRoot();
  if (process.env.CLAUGE_HOME) {
    return path.join(root, 'Library', 'Caches', APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(root, 'Library', 'Caches', APP_NAME);
  }
  if (process.platform === 'win32') {
    const localappdata =
      process.env.LOCALAPPDATA || path.join(root, 'AppData', 'Local');
    return path.join(localappdata, APP_NAME);
  }
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(root, '.cache');
  return path.join(xdgCache, APP_NAME);
}

function logsDirInternal() {
  const root = homeRoot();
  if (process.env.CLAUGE_HOME) {
    return path.join(root, 'Library', 'Logs', APP_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(root, 'Library', 'Logs', APP_NAME);
  }
  // Windows + Linux: colocate logs under cache for simplicity.
  return path.join(cacheDirInternal(), 'logs');
}

function preferencesFileInternal() {
  const root = homeRoot();
  if (process.env.CLAUGE_HOME) {
    return path.join(root, 'Library', 'Preferences', `${BUNDLE_ID}.plist`);
  }
  if (process.platform === 'darwin') {
    return path.join(root, 'Library', 'Preferences', `${BUNDLE_ID}.plist`);
  }
  // Non-macOS: no separate plist; settings live in settingsFile().
  return path.join(appDataDir(), 'preferences.json');
}

export const configPaths = {
  settingsFile: () => path.join(appDataDir(), 'settings.json'),
  // Sidecar-owned dotfile (~/.clauge/config.json), deliberately separate
  // from the Tauri-store appDataDir (see lib/config-store.js docstring).
  // Resolves the home root through homeRoot() so the CLAUGE_HOME override
  // sandboxes it cross-platform — unlike a raw os.homedir(), which reads
  // USERPROFILE (not HOME) on Windows.
  configFile: () => path.join(homeRoot(), '.clauge', 'config.json'),
  // Sidecar-owned fired-alert state (~/.clauge/alert-state.json), beside
  // config.json. Same homeRoot() resolution so CLAUGE_HOME sandboxes it
  // cross-platform (landmine #14 / #40 — sidecar-owned, never settings.json).
  alertStateFile: () => path.join(homeRoot(), '.clauge', 'alert-state.json'),
  // Clauge Widget stale cache (~/.clauge/statusline-cache.json): last-good
  // /v1/usage snapshots so `clauge status` can serve stale-but-shown while
  // the app is down. Written atomically (unique tmp + rename — statusline
  // renders overlap). Same homeRoot() resolution as its siblings.
  statuslineCacheFile: () => path.join(homeRoot(), '.clauge', 'statusline-cache.json'),
  preferencesFile: () => preferencesFileInternal(),
  logsDir: () => logsDirInternal(),
  cacheDir: () => cacheDirInternal(),
  portFile: () => path.join(cacheDirInternal(), 'active-port'),
  keychainItems: {
    anthropicOAuth: 'Claude Code-credentials',
    claudeAiSession: 'com.clauding.clauge.claude-ai-session',
    trialCounter: 'com.clauding.clauge.trial-counter',
    anthropicAdmin: 'com.clauding.clauge.anthropic-admin-key',
  },
};
