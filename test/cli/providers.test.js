// Tests for lib/providers.js — the provider catalogue + settings.json
// reader. CLAUGE_HOME isolation routes the reads into a tmpdir so we
// can stage arbitrary settings shapes per test.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import os from 'node:os';
import path from 'node:path';

let tmpHome;
let originalHome;

async function withCleanTmpHome() {
  tmpHome = path.join(os.tmpdir(), `clauge-providers-test-${process.pid}-${Date.now()}`);
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

async function stageSettings(json) {
  // Match where lib/config-paths.js puts settingsFile() under CLAUGE_HOME.
  const fresh = await import(`../../lib/config-paths.js?t=${Date.now()}-stage`);
  const settingsPath = fresh.configPaths.settingsFile();
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(json), 'utf8');
}

async function freshProvidersModule() {
  // Bust the import cache so config-paths re-reads CLAUGE_HOME.
  return await import(`../../lib/providers.js?t=${Date.now()}-prov`);
}

describe('listProviders — defaults when settings.json is absent', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('returns exactly four providers in stable order', async () => {
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    assert.equal(list.length, 4);
    assert.deepEqual(
      list.map((p) => p.name),
      ['anthropic-oauth', 'claude-ai-session', 'clauge-sync', 'anthropic-admin'],
    );
  });

  test('default enabled flags match the catalogue (admin off, others on)', async () => {
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    const byName = Object.fromEntries(list.map((p) => [p.name, p]));
    assert.equal(byName['anthropic-oauth'].enabled, true);
    assert.equal(byName['claude-ai-session'].enabled, true);
    assert.equal(byName['clauge-sync'].enabled, true);
    assert.equal(byName['anthropic-admin'].enabled, false);
  });

  test('each provider has a displayName and description', async () => {
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    for (const p of list) {
      assert.ok(p.displayName && p.displayName.length > 0, `${p.name} needs displayName`);
      assert.ok(p.description && p.description.length > 10, `${p.name} needs description`);
    }
  });
});

describe('listProviders — settings.json overrides', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('explicit enabled:false override applies', async () => {
    await stageSettings({
      providers: { 'anthropic-oauth': { enabled: false } },
    });
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    const oauth = list.find((p) => p.name === 'anthropic-oauth');
    assert.equal(oauth.enabled, false);
  });

  test('explicit enabled:true on admin overrides the default off', async () => {
    await stageSettings({
      providers: { 'anthropic-admin': { enabled: true } },
    });
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    const admin = list.find((p) => p.name === 'anthropic-admin');
    assert.equal(admin.enabled, true);
  });

  test('non-object providers section falls back to defaults', async () => {
    await stageSettings({ providers: 'garbage' });
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    assert.equal(list.find((p) => p.name === 'anthropic-oauth').enabled, true);
  });

  test('missing enabled key on a present provider entry uses default', async () => {
    await stageSettings({
      providers: { 'anthropic-oauth': { somethingElse: 'foo' } },
    });
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    assert.equal(list.find((p) => p.name === 'anthropic-oauth').enabled, true);
  });

  test('coexists with existing wizard flags in settings.json', async () => {
    await stageSettings({
      onboarding_completed: true,
      first_launch_done: true,
      providers: { 'clauge-sync': { enabled: false } },
    });
    const { listProviders } = await freshProvidersModule();
    const list = await listProviders();
    assert.equal(list.find((p) => p.name === 'clauge-sync').enabled, false);
    assert.equal(list.find((p) => p.name === 'anthropic-oauth').enabled, true);
  });
});

describe('readSettings — malformed file handling', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('invalid JSON returns empty object', async () => {
    const fresh = await import(`../../lib/config-paths.js?t=${Date.now()}-r1`);
    const settingsPath = fresh.configPaths.settingsFile();
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, 'not valid json {', 'utf8');
    const { readSettings } = await freshProvidersModule();
    const s = await readSettings();
    assert.deepEqual(s, {});
  });

  test('JSON array (non-object root) returns empty object', async () => {
    await stageSettings([1, 2, 3]);
    const { readSettings } = await freshProvidersModule();
    const s = await readSettings();
    assert.deepEqual(s, {});
  });

  test('absent file returns empty object', async () => {
    const { readSettings } = await freshProvidersModule();
    const s = await readSettings();
    assert.deepEqual(s, {});
  });
});
