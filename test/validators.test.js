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
