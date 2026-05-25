// Tests for lib/cli/config-get.js. CLAUGE_HOME isolates port-file +
// settings.json reads. The HTTP path uses an injected stub fetch.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import os from 'node:os';
import path from 'node:path';

let tmpHome;
let originalHome;

async function withCleanTmpHome() {
  tmpHome = path.join(os.tmpdir(), `clauge-config-get-test-${process.pid}-${Date.now()}`);
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

async function freshModule() {
  return await import(`../../lib/cli/config-get.js?t=${Date.now()}-${Math.random()}`);
}

async function stagePortFile(port) {
  const cp = await import(`../../lib/config-paths.js?t=${Date.now()}-port`);
  const p = cp.configPaths.portFile();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, String(port), 'utf8');
}

describe('buildConfigOutput — offline fallback', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('returns { running: false, providers } when port file is absent', async () => {
    const mod = await freshModule();
    const out = await mod.buildConfigOutput();
    assert.equal(out.running, false);
    assert.ok(Array.isArray(out.providers));
    assert.equal(out.providers.length, 4);
    assert.ok(!Object.prototype.hasOwnProperty.call(out, 'port'));
  });

  test('returns { running: false, providers } when port file points at dead port', async () => {
    // Port 1 is privileged + nothing will be listening — connection refused.
    await stagePortFile(1);
    const mod = await freshModule();
    const out = await mod.buildConfigOutput();
    assert.equal(out.running, false);
  });

  test('returns { running: false, providers } when port file is garbage', async () => {
    await stagePortFile('not-a-port');
    const mod = await freshModule();
    const out = await mod.buildConfigOutput();
    assert.equal(out.running, false);
  });
});

describe('buildConfigOutput — HTTP path (stub fetch)', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('returns running:true + port + live data when fetch succeeds', async () => {
    await stagePortFile(34567);
    const stubLive = {
      claudeDir: '/some/where',
      subscriptionCost: 200,
      providers: [{ name: 'x', displayName: 'X', enabled: true, description: 'x' }],
    };
    const stubFetch = async () =>
      new Response(JSON.stringify(stubLive), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const mod = await freshModule();
    const out = await mod.buildConfigOutput({ fetchImpl: stubFetch });
    assert.equal(out.running, true);
    assert.equal(out.port, 34567);
    assert.equal(out.claudeDir, '/some/where');
    assert.equal(out.providers.length, 1);
  });

  test('falls back to offline shape on 500 response', async () => {
    await stagePortFile(34567);
    const stubFetch = async () => new Response('boom', { status: 500 });
    const mod = await freshModule();
    const out = await mod.buildConfigOutput({ fetchImpl: stubFetch });
    assert.equal(out.running, false);
    assert.ok(Array.isArray(out.providers));
  });

  test('falls back to offline shape on fetch throw (network error)', async () => {
    await stagePortFile(34567);
    const stubFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const mod = await freshModule();
    const out = await mod.buildConfigOutput({ fetchImpl: stubFetch });
    assert.equal(out.running, false);
  });
});

describe('run — dispatcher entrypoint', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('prints valid JSON to stdout and returns exit 0', async () => {
    const original = process.stdout.write.bind(process.stdout);
    const chunks = [];
    process.stdout.write = (chunk) => {
      chunks.push(chunk.toString());
      return true;
    };
    try {
      const mod = await freshModule();
      const code = await mod.run({ verb: 'config', subverb: 'get', flags: {}, positional: [] });
      assert.equal(code, 0);
      const output = chunks.join('');
      const parsed = JSON.parse(output);
      assert.equal(parsed.running, false);
      assert.ok(Array.isArray(parsed.providers));
    } finally {
      process.stdout.write = original;
    }
  });
});
