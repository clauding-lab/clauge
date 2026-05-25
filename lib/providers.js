// Provider model: the four data sources Clauge knows about, plus the
// "enabled" toggle per provider.
//
// Provider data:
//   - name (stable kebab-case id)
//   - displayName (human-facing label)
//   - enabled (per-user setting from settings.json; default true except
//     for the forward-looking anthropic-admin)
//   - description (one-line explainer for `clauge config providers`)
//
// `connectionStatus` is intentionally absent — it requires Keychain
// probes on macOS that the JS sidecar can't do safely without prompting,
// and an IPC bridge to the Rust shell isn't shipped until task #9.
// Once that lands, this module is the natural place to compose the
// per-provider status.

import { readFile } from 'node:fs/promises';
import { configPaths } from './config-paths.js';

export const PROVIDERS = [
  {
    name: 'anthropic-oauth',
    displayName: 'Claude Code',
    defaultEnabled: true,
    description:
      'Reads the OAuth blob Claude Code writes to your system credential store (Keychain on macOS, ~/.claude/.credentials.json on Windows).',
  },
  {
    name: 'claude-ai-session',
    displayName: 'claude.ai',
    defaultEnabled: true,
    description:
      'Reads the claude.ai browser session token (stored in Keychain after sign-in via the Welcome wizard).',
  },
  {
    name: 'clauge-sync',
    displayName: 'Clauge Sync (extension)',
    defaultEnabled: true,
    description:
      'Receives plan-usage POSTs from the Clauge Sync browser extension running in your claude.ai tab.',
  },
  {
    name: 'anthropic-admin',
    displayName: 'Anthropic Admin Key',
    defaultEnabled: false,
    description:
      'Forward-looking: an admin API key used for v0.10.0 IAP / billing flows. Not yet active.',
  },
];

/**
 * Read settings.json (the Tauri plugin_store file) and merge with the
 * provider catalogue. Missing file or unreadable contents → all providers
 * fall back to defaultEnabled.
 *
 * @returns {Promise<Array<{name, displayName, enabled, description}>>}
 */
export async function listProviders() {
  const settings = await readSettings();
  return PROVIDERS.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    enabled: readEnabledFlag(settings, p.name, p.defaultEnabled),
    description: p.description,
  }));
}

/**
 * Read the Tauri plugin_store settings.json from disk. Returns {} on any
 * read or parse error — the caller treats absence as "use defaults".
 *
 * @returns {Promise<object>}
 */
export async function readSettings() {
  try {
    const raw = await readFile(configPaths.settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function readEnabledFlag(settings, providerName, defaultValue) {
  // Settings key shape: providers.<name>.enabled (matches Rust shell's
  // future write path). If the section or flag is missing, fall back.
  const providers = settings.providers;
  if (!providers || typeof providers !== 'object') return defaultValue;
  const entry = providers[providerName];
  if (!entry || typeof entry !== 'object') return defaultValue;
  return typeof entry.enabled === 'boolean' ? entry.enabled : defaultValue;
}
