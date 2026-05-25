// Atomic settings.json writer for CLI-driven changes.
//
// settings.json lives at configPaths.settingsFile() — the same file the
// Tauri plugin_store reads/writes for wizard state. The writer:
//   1. Reads the current file (treating any error / non-object root as {})
//   2. Merges the change into the providers section
//   3. Writes to .settings.json.tmp + atomic rename
//
// Known race (v0.9.3): if the Tauri shell's plugin_store has the file
// cached in-memory and calls store.save() AFTER our write, it'll
// overwrite our change with the in-memory state — which doesn't include
// our providers update. In practice this requires the user to toggle a
// provider via CLI AND complete the wizard via dashboard at the same
// moment. Documented in AGENTS.md landmine #14. The fix (Rust IPC
// bridge for settings writes) is deferred to v0.9.4.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { configPaths } from './config-paths.js';

async function readSettingsOrEmpty() {
  try {
    const raw = await readFile(configPaths.settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

async function writeAtomic(obj) {
  const path = configPaths.settingsFile();
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), '.settings.json.tmp');
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await rename(tmp, path);
}

/**
 * Set the `enabled` flag for a provider in settings.json. Returns the
 * updated providers section (so callers can confirm the change).
 *
 * @param {string} providerName
 * @param {boolean} enabled
 * @returns {Promise<object>}
 */
export async function setProviderEnabled(providerName, enabled) {
  const current = await readSettingsOrEmpty();
  const providersSection = isPlainObject(current.providers) ? { ...current.providers } : {};
  const entry = isPlainObject(providersSection[providerName])
    ? { ...providersSection[providerName] }
    : {};
  entry.enabled = enabled;
  providersSection[providerName] = entry;
  const next = { ...current, providers: providersSection };
  await writeAtomic(next);
  return providersSection;
}
