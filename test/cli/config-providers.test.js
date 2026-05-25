// Tests for lib/cli/config-providers.js.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpHome;
let originalHome;

async function withCleanTmpHome() {
  tmpHome = path.join(os.tmpdir(), `clauge-providers-cli-test-${process.pid}-${Date.now()}`);
  await rm(tmpHome, { recursive: true, force: true });
  await mkdir(tmpHome, { recursive: true });
  originalHome = process.env.CLAUGE_HOME;
  process.env.CLAUGE_HOME = tmpHome;
}

async function restoreHome() {
  if (originalHome === undefined) delete process.env.CLAUGE_HOME;
  else process.env.CLAUGE_HOME = originalHome;
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
}

function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(chunk.toString());
    return true;
  };
  return Promise.resolve(fn()).then(
    (result) => {
      process.stdout.write = original;
      return { result, output: chunks.join('') };
    },
    (err) => {
      process.stdout.write = original;
      throw err;
    },
  );
}

async function freshModule() {
  return await import(`../../lib/cli/config-providers.js?t=${Date.now()}-${Math.random()}`);
}

describe('clauge config providers — default tabular output', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('prints a header row + one row per provider', async () => {
    const mod = await freshModule();
    const { result, output } = await captureStdout(() =>
      mod.run({ verb: 'config', subverb: 'providers', flags: {}, positional: [] }),
    );
    assert.equal(result, 0);
    assert.match(output, /PROVIDER\s+STATUS\s+LABEL/);
    assert.match(output, /anthropic-oauth\s+on\s+Claude Code/);
    assert.match(output, /claude-ai-session\s+on\s+claude\.ai/);
    assert.match(output, /clauge-sync\s+on\s+Clauge Sync/);
    assert.match(output, /anthropic-admin\s+off\s+Anthropic Admin Key/);
  });

  test('prints a "not running" note when offline (no port file)', async () => {
    const mod = await freshModule();
    const { output } = await captureStdout(() =>
      mod.run({ verb: 'config', subverb: 'providers', flags: {}, positional: [] }),
    );
    assert.match(output, /not running/i);
  });
});

describe('clauge config providers --json', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('emits valid JSON array with 4 providers when --json is set', async () => {
    const mod = await freshModule();
    const { result, output } = await captureStdout(() =>
      mod.run({
        verb: 'config',
        subverb: 'providers',
        flags: { json: true },
        positional: [],
      }),
    );
    assert.equal(result, 0);
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 4);
    for (const p of parsed) {
      assert.ok(p.name && typeof p.name === 'string');
      assert.ok(typeof p.enabled === 'boolean');
    }
  });

  test('--json suppresses the "not running" note', async () => {
    const mod = await freshModule();
    const { output } = await captureStdout(() =>
      mod.run({
        verb: 'config',
        subverb: 'providers',
        flags: { json: true },
        positional: [],
      }),
    );
    assert.doesNotMatch(output, /not running/i);
  });
});
