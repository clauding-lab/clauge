// Tests for lib/cli/status-install.js — `clauge status --install` writes the
// statusLine command into ~/.claude/settings.json with aiusage's civility
// rules (spec §4, rev 4): refuse to clobber a different statusLine without
// --force, back up first, bail untouched on invalid JSON, name what is
// being replaced. CLAUDE_DIR (injected env) sandboxes the settings file.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpClaudeDir;

beforeEach(async () => {
  tmpClaudeDir = path.join(os.tmpdir(), `clauge-install-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpClaudeDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpClaudeDir, { recursive: true, force: true });
});

async function freshModule() {
  return await import(`../../lib/cli/status.js?t=${Date.now()}-${Math.random()}`);
}

function parsed(flags = {}) {
  return { verb: 'status', subverb: null, flags: { install: true, ...flags }, positional: [] };
}

function deps() {
  return { env: { CLAUDE_DIR: tmpClaudeDir }, nowMs: Date.parse('2026-07-18T12:00:00Z') };
}

async function capture(fn) {
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const out = [];
  const err = [];
  process.stdout.write = (c) => (out.push(c.toString()), true);
  process.stderr.write = (c) => (err.push(c.toString()), true);
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
}

const settingsPath = () => path.join(tmpClaudeDir, 'settings.json');
const backupPath = () => path.join(tmpClaudeDir, 'settings.json.backup');

describe('fresh install', () => {
  test('creates settings.json with a command statusLine ending in " status"', async () => {
    const mod = await freshModule();
    const { code, stdout } = await capture(() => mod.run(parsed(), deps()));
    assert.equal(code, 0);
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'));
    assert.equal(settings.statusLine.type, 'command');
    assert.match(settings.statusLine.command, / status$/);
    assert.match(stdout, /installed/i);
  });

  test('house JSON style: 2-space indent, trailing newline', async () => {
    const mod = await freshModule();
    await capture(() => mod.run(parsed(), deps()));
    const raw = await readFile(settingsPath(), 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.match(raw, /\n  "statusLine"/);
  });

  test('no backup file is created when there was nothing to back up', async () => {
    const mod = await freshModule();
    await capture(() => mod.run(parsed(), deps()));
    await assert.rejects(() => stat(backupPath()));
  });
});

describe('existing settings.json', () => {
  test('preserves unrelated keys and backs up the original first', async () => {
    const original = { model: 'opus', permissions: { allow: ['Bash'] } };
    await writeFile(settingsPath(), JSON.stringify(original, null, 2) + '\n', 'utf8');
    const mod = await freshModule();
    const { code } = await capture(() => mod.run(parsed(), deps()));
    assert.equal(code, 0);
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'));
    assert.equal(settings.model, 'opus');
    assert.deepEqual(settings.permissions, { allow: ['Bash'] });
    assert.equal(settings.statusLine.type, 'command');
    const backup = JSON.parse(await readFile(backupPath(), 'utf8'));
    assert.deepEqual(backup, original);
  });

  test('re-running against its own install is a no-op success', async () => {
    const mod = await freshModule();
    await capture(() => mod.run(parsed(), deps()));
    const before = await readFile(settingsPath(), 'utf8');
    const { code, stdout } = await capture(() => mod.run(parsed(), deps()));
    assert.equal(code, 0);
    assert.match(stdout, /already/i);
    assert.equal(await readFile(settingsPath(), 'utf8'), before);
  });

  test('refuses to clobber a DIFFERENT statusLine without --force, naming it', async () => {
    const existing = {
      statusLine: { type: 'command', command: 'npx ccstatusline' },
    };
    await writeFile(settingsPath(), JSON.stringify(existing, null, 2) + '\n', 'utf8');
    const before = await readFile(settingsPath(), 'utf8');
    const mod = await freshModule();
    const { code, stderr } = await capture(() => mod.run(parsed(), deps()));
    assert.equal(code, 1);
    assert.match(stderr, /ccstatusline/, 'must name what it refuses to replace');
    assert.match(stderr, /--force/);
    assert.equal(await readFile(settingsPath(), 'utf8'), before, 'file untouched');
  });

  test('--force replaces the foreign statusLine and backs up the loser', async () => {
    const existing = { statusLine: { type: 'command', command: 'npx ccstatusline' } };
    await writeFile(settingsPath(), JSON.stringify(existing, null, 2) + '\n', 'utf8');
    const mod = await freshModule();
    const { code } = await capture(() => mod.run(parsed({ force: true }), deps()));
    assert.equal(code, 0);
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8'));
    assert.match(settings.statusLine.command, / status$/);
    const backup = JSON.parse(await readFile(backupPath(), 'utf8'));
    assert.equal(backup.statusLine.command, 'npx ccstatusline');
  });

  test('bails untouched on invalid JSON — no write, no backup, exit 1', async () => {
    await writeFile(settingsPath(), '{ definitely not json', 'utf8');
    const mod = await freshModule();
    const { code, stderr } = await capture(() => mod.run(parsed({ force: true }), deps()));
    assert.equal(code, 1);
    assert.match(stderr, /invalid|parse/i);
    assert.equal(await readFile(settingsPath(), 'utf8'), '{ definitely not json');
    await assert.rejects(() => stat(backupPath()));
  });
});
