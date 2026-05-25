// Tests for lib/cli/config-enable.js + config-disable.js. CLAUGE_HOME
// isolates writes; toggleProvider's fetchImpl injection isn't exposed
// at the run() level, so we only test the offline path here (port file
// absent → disk write). The HTTP path is exercised by integration in
// later work.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpHome;
let originalHome;

async function withCleanTmpHome() {
  tmpHome = path.join(os.tmpdir(), `clauge-enable-test-${process.pid}-${Date.now()}`);
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

async function readSettings() {
  const cp = await import(`../../lib/config-paths.js?t=${Date.now()}-r`);
  const raw = await readFile(cp.configPaths.settingsFile(), 'utf8');
  return JSON.parse(raw);
}

function captureStreams(fn) {
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  const stdoutChunks = [];
  const stderrChunks = [];
  process.stdout.write = (chunk) => {
    stdoutChunks.push(chunk.toString());
    return true;
  };
  process.stderr.write = (chunk) => {
    stderrChunks.push(chunk.toString());
    return true;
  };
  return Promise.resolve(fn()).then(
    (result) => {
      process.stdout.write = stdoutOriginal;
      process.stderr.write = stderrOriginal;
      return { result, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
    },
    (err) => {
      process.stdout.write = stdoutOriginal;
      process.stderr.write = stderrOriginal;
      throw err;
    },
  );
}

describe('config enable', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('enables a provider via disk fallback when offline', async () => {
    const mod = await import(`../../lib/cli/config-enable.js?t=${Date.now()}-e1`);
    const { result, stdout } = await captureStreams(() =>
      mod.run({ verb: 'config', subverb: 'enable', flags: { provider: 'anthropic-admin' }, positional: [] }),
    );
    assert.equal(result, 0);
    assert.match(stdout, /anthropic-admin: enabled/);
    const s = await readSettings();
    assert.equal(s.providers['anthropic-admin'].enabled, true);
  });

  test('rejects unknown provider names', async () => {
    const mod = await import(`../../lib/cli/config-enable.js?t=${Date.now()}-e2`);
    const { result, stderr } = await captureStreams(() =>
      mod.run({ verb: 'config', subverb: 'enable', flags: { provider: 'bogus' }, positional: [] }),
    );
    assert.equal(result, 2);
    assert.match(stderr, /unknown provider/i);
  });

  test('requires --provider flag', async () => {
    const mod = await import(`../../lib/cli/config-enable.js?t=${Date.now()}-e3`);
    const { result, stderr } = await captureStreams(() =>
      mod.run({ verb: 'config', subverb: 'enable', flags: {}, positional: [] }),
    );
    assert.equal(result, 2);
    assert.match(stderr, /usage:/);
  });
});

describe('config disable', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('disables a provider via disk fallback', async () => {
    const mod = await import(`../../lib/cli/config-disable.js?t=${Date.now()}-d1`);
    const { result, stdout } = await captureStreams(() =>
      mod.run({ verb: 'config', subverb: 'disable', flags: { provider: 'clauge-sync' }, positional: [] }),
    );
    assert.equal(result, 0);
    assert.match(stdout, /clauge-sync: disabled/);
    const s = await readSettings();
    assert.equal(s.providers['clauge-sync'].enabled, false);
  });
});
