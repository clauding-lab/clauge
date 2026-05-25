#!/usr/bin/env node
// Architecture guardrail (v0.9.4 Phase B.7).
//
// Tauri IPC triple-registration check. Codifies AGENTS.md landmine #1: every
// Tauri command that the dashboard webview can invoke must be registered in
// THREE places, or it gets silently rejected by Tauri at runtime.
//
// Specifically:
//   1. `#[tauri::command]` in some src-tauri/src/*.rs
//   2. lib.rs's `generate_handler![]` macro
//   3. build.rs's `APP_COMMANDS` array  AND  capabilities/main.json's
//      `permissions` array under `allow-<kebab-name>` — both are needed
//      because tauri-build derives the allow-/deny- permissions from
//      APP_COMMANDS, and capabilities references them by name.
//
// Popover-only commands (e.g. `quit_app`, `proxy_fetch`) do NOT need APP_COMMANDS
// + capabilities entries — the popover loads at `tauri://localhost`, which Tauri
// trusts by default. Those just need invoke_handler registration.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.env.CLAUGE_REPO_ROOT
  ? path.resolve(process.env.CLAUGE_REPO_ROOT)
  : path.resolve(__dirname, '..');
const SRC_TAURI = path.join(REPO_ROOT, 'src-tauri');

function readAllRustSources(dir) {
  const result = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.rs')) result.push(p);
    }
  }
  walk(dir);
  return result;
}

function collectMatches(source, pattern) {
  const out = [];
  for (const m of source.matchAll(pattern)) out.push(m);
  return out;
}

function stripRustComments(src) {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function findTauriCommands(rustFiles) {
  const cmds = new Set();
  // Anchor the attribute immediately above the fn (whitespace only between
  // them) so a `//! ...#[tauri::command]...` doc comment paired with an
  // unrelated `fn` later in the same file can't false-positive.
  const pattern = /#\[tauri::command(?:\([^)]*\))?\]\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/g;
  for (const f of rustFiles) {
    const src = stripRustComments(fs.readFileSync(f, 'utf8'));
    for (const m of collectMatches(src, pattern)) cmds.add(m[1]);
  }
  return cmds;
}

function readInvokeHandlerCommands(libRsPath) {
  const src = fs.readFileSync(libRsPath, 'utf8');
  const m = src.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!m) throw new Error('generate_handler![] block not found in lib.rs');
  const body = m[1]
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();
  for (const n of collectMatches(body, /(?:[a-zA-Z_][a-zA-Z0-9_]*::)*([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    names.add(n[1]);
  }
  return names;
}

function readAppCommands(buildRsPath) {
  const src = fs.readFileSync(buildRsPath, 'utf8');
  const m = src.match(/const\s+APP_COMMANDS\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/);
  if (!m) throw new Error('APP_COMMANDS block not found in build.rs');
  const names = new Set();
  for (const n of collectMatches(m[1], /"([a-zA-Z_][a-zA-Z0-9_]*)"/g)) names.add(n[1]);
  return names;
}

function readCapabilityAllowEntries(jsonPath) {
  const obj = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const perms = obj.permissions || [];
  const names = new Set();
  for (const p of perms) {
    if (typeof p !== 'string') continue;
    if (p.startsWith('allow-') && !p.includes(':')) {
      names.add(p.slice('allow-'.length).replace(/-/g, '_'));
    }
  }
  return names;
}

function main() {
  const rustFiles = readAllRustSources(path.join(SRC_TAURI, 'src'));
  const commands = findTauriCommands(rustFiles);
  const invoked = readInvokeHandlerCommands(path.join(SRC_TAURI, 'src', 'lib.rs'));
  const appCmds = readAppCommands(path.join(SRC_TAURI, 'build.rs'));
  const allowList = readCapabilityAllowEntries(path.join(SRC_TAURI, 'capabilities', 'main.json'));

  const errors = [];

  for (const cmd of commands) {
    if (!invoked.has(cmd)) {
      errors.push(`#[tauri::command] \`${cmd}\` is missing from lib.rs generate_handler![]`);
    }
  }

  for (const cmd of appCmds) {
    if (!commands.has(cmd)) {
      errors.push(`APP_COMMANDS entry \`${cmd}\` has no matching #[tauri::command] in src-tauri/src/`);
    }
    if (!invoked.has(cmd)) {
      errors.push(`APP_COMMANDS entry \`${cmd}\` is missing from lib.rs generate_handler![]`);
    }
    if (!allowList.has(cmd)) {
      const kebab = cmd.replace(/_/g, '-');
      errors.push(`APP_COMMANDS entry \`${cmd}\` is missing \`allow-${kebab}\` in capabilities/main.json`);
    }
  }

  for (const name of allowList) {
    if (!appCmds.has(name)) {
      const kebab = name.replace(/_/g, '-');
      errors.push(`capabilities/main.json has \`allow-${kebab}\` but APP_COMMANDS doesn't list \`${name}\` (dead permission)`);
    }
  }

  if (errors.length > 0) {
    console.error('[validate-ipc-triple-register] FAIL - Tauri IPC drift detected:\n');
    for (const e of errors) console.error('  - ' + e);
    console.error('\nSee AGENTS.md landmine #1 for context.');
    process.exit(1);
  }

  process.stdout.write(
    `[validate-ipc-triple-register] OK - ${commands.size} #[tauri::command] fns, ` +
    `${invoked.size} in generate_handler!, ${appCmds.size} APP_COMMANDS, ${allowList.size} app-level allow- permissions\n`,
  );
}

main();
