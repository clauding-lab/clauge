// Architecture-guardrail validator smoke tests (v0.9.4 Phase B.7).
//
// Each of the three validators is asserted twice:
//   1. Passing case — runs against the live repo. The validator's exit code 0
//      is the assertion. Drift introduced in any future commit (a #[tauri::command]
//      added without invoke_handler updates, a console.log slipped into lib/,
//      a hardcoded :3456 in popover/) will fail this test immediately.
//   2. Failing case — runs against a temp-dir fixture seeded with a deliberate
//      violation. The validator must exit non-zero with a useful message.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCRIPTS = {
  ipc: join(REPO_ROOT, 'scripts', 'validate-ipc-triple-register.cjs'),
  consoleLog: join(REPO_ROOT, 'scripts', 'validate-no-console-log.cjs'),
  port: join(REPO_ROOT, 'scripts', 'validate-no-hardcoded-port.cjs'),
  htmlFacade: join(REPO_ROOT, 'scripts', 'validate-html-facade-loads.cjs'),
};

function runValidator(scriptPath, opts = {}) {
  const env = { ...process.env };
  if (opts.rootOverride) env.CLAUGE_REPO_ROOT = opts.rootOverride;
  return spawnSync('node', [scriptPath], { env, encoding: 'utf8' });
}

function makeFixture() {
  return mkdtempSync(join(tmpdir(), 'clauge-validator-'));
}

// ─── validate-ipc-triple-register ───────────────────────────

test('validate-ipc-triple-register: passes against the live tree', () => {
  const res = runValidator(SCRIPTS.ipc);
  assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});

test('validate-ipc-triple-register: fails when a #[tauri::command] is missing from generate_handler!', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src-tauri', 'src'), { recursive: true });
    mkdirSync(join(root, 'src-tauri', 'capabilities'), { recursive: true });
    // Command defined but NEVER referenced in lib.rs / build.rs / capabilities.
    writeFileSync(
      join(root, 'src-tauri', 'src', 'ipc.rs'),
      '#[tauri::command]\npub fn ghost_command() {}\n',
    );
    writeFileSync(
      join(root, 'src-tauri', 'src', 'lib.rs'),
      'pub fn run() { generate_handler![]; }\n',
    );
    writeFileSync(
      join(root, 'src-tauri', 'build.rs'),
      'const APP_COMMANDS: &[&str] = &[];\n',
    );
    writeFileSync(
      join(root, 'src-tauri', 'capabilities', 'main.json'),
      JSON.stringify({ permissions: [] }),
    );
    const res = runValidator(SCRIPTS.ipc, { rootOverride: root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /ghost_command/);
    assert.match(res.stderr, /generate_handler/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── validate-no-console-log ────────────────────────────────

test('validate-no-console-log: passes against the live tree', () => {
  const res = runValidator(SCRIPTS.consoleLog);
  assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});

test('validate-no-console-log: fails when console.log lands in lib/', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'lib'), { recursive: true });
    mkdirSync(join(root, 'popover'), { recursive: true });
    writeFileSync(
      join(root, 'lib', 'noisy.js'),
      'export function f() { console.log("debug"); }\n',
    );
    const res = runValidator(SCRIPTS.consoleLog, { rootOverride: root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /noisy\.js/);
    assert.match(res.stderr, /console\.log/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── validate-no-hardcoded-port ─────────────────────────────

test('validate-no-hardcoded-port: passes against the live tree', () => {
  const res = runValidator(SCRIPTS.port);
  assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});

test('validate-no-hardcoded-port: fails when :3456 appears in popover/', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'popover'), { recursive: true });
    writeFileSync(
      join(root, 'popover', 'bad.js'),
      "fetch('http://127.0.0.1:3456/api/health');\n",
    );
    const res = runValidator(SCRIPTS.port, { rootOverride: root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /bad\.js/);
    assert.match(res.stderr, /3456/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── validate-html-facade-loads (v0.9.7) ──────────────────

test('validate-html-facade-loads: passes against the live tree', () => {
  const res = runValidator(SCRIPTS.htmlFacade);
  assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
  assert.match(res.stdout, /OK/);
});

test('validate-html-facade-loads: fails when an HTML loads facade-using JS without lib/tauri-bridge.js', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'popover', 'lib'), { recursive: true });
    // The bridge file — defines window.ClaugeBridge.
    writeFileSync(
      join(root, 'popover', 'lib', 'tauri-bridge.js'),
      "window.ClaugeBridge = { isTauriAvailable: () => false };\n",
    );
    // A facade-using JS file — references ClaugeBridge.
    writeFileSync(
      join(root, 'popover', 'splash.js'),
      "if (!ClaugeBridge.isTauriAvailable()) console.warn('no bridge');\n",
    );
    // HTML that loads splash.js but NOT the bridge — the bug.
    writeFileSync(
      join(root, 'popover', 'splash.html'),
      '<!DOCTYPE html><html><body><script src="splash.js"></script></body></html>',
    );
    const res = runValidator(SCRIPTS.htmlFacade, { rootOverride: root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /splash\.html/);
    assert.match(res.stderr, /ClaugeBridge/);
    assert.match(res.stderr, /never loaded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate-html-facade-loads: fails when the bridge is loaded AFTER the facade-using JS', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'popover', 'lib'), { recursive: true });
    writeFileSync(
      join(root, 'popover', 'lib', 'tauri-bridge.js'),
      "window.ClaugeBridge = { isTauriAvailable: () => false };\n",
    );
    writeFileSync(
      join(root, 'popover', 'splash.js'),
      "ClaugeBridge.isTauriAvailable();\n",
    );
    // Wrong order: splash.js BEFORE tauri-bridge.js. Order matters even with defer.
    writeFileSync(
      join(root, 'popover', 'splash.html'),
      '<!DOCTYPE html><html><body>'
        + '<script src="splash.js"></script>'
        + '<script src="lib/tauri-bridge.js"></script>'
        + '</body></html>',
    );
    const res = runValidator(SCRIPTS.htmlFacade, { rootOverride: root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BEFORE the ClaugeBridge definer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// v0.9.8: second facade — t() from popover/lib/copy.js. Same shape as the
// ClaugeBridge rule but a different definer/user pair. Mirrors the
// v0.9.7 -> v0.9.8 dashboard heatmap regression that motivated the
// extension (see scripts/validate-html-facade-loads.cjs header comment).

test('validate-html-facade-loads: fails when an HTML loads t()-using JS without lib/copy.js', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'popover', 'lib'), { recursive: true });
    // copy.js — defines window.t.
    writeFileSync(
      join(root, 'popover', 'lib', 'copy.js'),
      "window.t = (key) => key;\n",
    );
    // heatmap.js — calls t('some.key') per cell.
    writeFileSync(
      join(root, 'popover', 'heatmap.js'),
      "function tooltip() { return t('heatmap.tooltipNoActivity'); }\n",
    );
    // HTML loads heatmap.js but NEVER loads copy.js — the dashboard bug.
    writeFileSync(
      join(root, 'popover', 'index.html'),
      '<!DOCTYPE html><html><body><script src="heatmap.js"></script></body></html>',
    );
    const res = runValidator(SCRIPTS.htmlFacade, { rootOverride: root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /index\.html/);
    assert.match(res.stderr, /t\(\)/);
    assert.match(res.stderr, /copy\.js is never loaded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate-html-facade-loads: fails when copy.js is loaded AFTER t()-using JS', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'popover', 'lib'), { recursive: true });
    writeFileSync(
      join(root, 'popover', 'lib', 'copy.js'),
      "window.t = (key) => key;\n",
    );
    writeFileSync(
      join(root, 'popover', 'heatmap.js'),
      "function tooltip() { return t('heatmap.tooltipNoActivity'); }\n",
    );
    // Wrong order: heatmap.js BEFORE lib/copy.js.
    writeFileSync(
      join(root, 'popover', 'index.html'),
      '<!DOCTYPE html><html><body>'
        + '<script src="heatmap.js"></script>'
        + '<script src="lib/copy.js"></script>'
        + '</body></html>',
    );
    const res = runValidator(SCRIPTS.htmlFacade, { rootOverride: root });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /BEFORE the t\(\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
