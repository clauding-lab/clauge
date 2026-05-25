// Tests for lib/settings-writer.js — atomic provider toggle writes.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import os from 'node:os';
import path from 'node:path';

let tmpHome;
let originalHome;

async function withCleanTmpHome() {
  tmpHome = path.join(os.tmpdir(), `clauge-settings-writer-test-${process.pid}-${Date.now()}`);
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

async function stageSettings(json) {
  const cp = await import(`../../lib/config-paths.js?t=${Date.now()}-s`);
  const p = cp.configPaths.settingsFile();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(json), 'utf8');
}

async function freshModule() {
  return await import(`../../lib/settings-writer.js?t=${Date.now()}-${Math.random()}`);
}

describe('setProviderEnabled — fresh write', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('creates settings.json + providers section when both absent', async () => {
    const mod = await freshModule();
    await mod.setProviderEnabled('anthropic-oauth', false);
    const s = await readSettings();
    assert.equal(s.providers['anthropic-oauth'].enabled, false);
  });

  test('preserves pre-existing wizard flags in settings.json', async () => {
    await stageSettings({ onboarding_completed: true, first_launch_done: true });
    const mod = await freshModule();
    await mod.setProviderEnabled('clauge-sync', false);
    const s = await readSettings();
    assert.equal(s.onboarding_completed, true);
    assert.equal(s.first_launch_done, true);
    assert.equal(s.providers['clauge-sync'].enabled, false);
  });
});

describe('setProviderEnabled — overwrites', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('flips enabled true → false', async () => {
    await stageSettings({
      providers: { 'anthropic-oauth': { enabled: true } },
    });
    const mod = await freshModule();
    await mod.setProviderEnabled('anthropic-oauth', false);
    const s = await readSettings();
    assert.equal(s.providers['anthropic-oauth'].enabled, false);
  });

  test('preserves other provider entries when updating one', async () => {
    await stageSettings({
      providers: {
        'anthropic-oauth': { enabled: false },
        'claude-ai-session': { enabled: false },
      },
    });
    const mod = await freshModule();
    await mod.setProviderEnabled('anthropic-oauth', true);
    const s = await readSettings();
    assert.equal(s.providers['anthropic-oauth'].enabled, true);
    assert.equal(s.providers['claude-ai-session'].enabled, false);
  });

  test('preserves non-enabled keys inside a provider entry', async () => {
    await stageSettings({
      providers: { 'anthropic-oauth': { enabled: true, extra: 'preserved' } },
    });
    const mod = await freshModule();
    await mod.setProviderEnabled('anthropic-oauth', false);
    const s = await readSettings();
    assert.equal(s.providers['anthropic-oauth'].enabled, false);
    assert.equal(s.providers['anthropic-oauth'].extra, 'preserved');
  });
});

describe('setProviderEnabled — malformed input recovery', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('discards array-valued providers section', async () => {
    await stageSettings({ providers: [1, 2, 3] });
    const mod = await freshModule();
    await mod.setProviderEnabled('clauge-sync', false);
    const s = await readSettings();
    assert.equal(typeof s.providers, 'object');
    assert.equal(Array.isArray(s.providers), false);
    assert.equal(s.providers['clauge-sync'].enabled, false);
  });

  test('discards array-valued individual provider entry', async () => {
    await stageSettings({ providers: { 'clauge-sync': ['bad'] } });
    const mod = await freshModule();
    await mod.setProviderEnabled('clauge-sync', false);
    const s = await readSettings();
    assert.equal(s.providers['clauge-sync'].enabled, false);
  });

  test('treats broken JSON as empty', async () => {
    const cp = await import(`../../lib/config-paths.js?t=${Date.now()}-broken`);
    const p = cp.configPaths.settingsFile();
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, 'not json', 'utf8');
    const mod = await freshModule();
    await mod.setProviderEnabled('clauge-sync', false);
    const s = await readSettings();
    assert.equal(s.providers['clauge-sync'].enabled, false);
  });
});
