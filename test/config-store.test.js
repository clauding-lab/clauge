// Unit tests for lib/config-store.js (Component 4 of the on-device
// projection spec, docs/superpowers/specs/2026-06-12-on-device-projection-design.md).
//
// Precedence under test: file value -> SUBSCRIPTION_COST env -> 200, with
// read-side validation at EVERY tier (non-finite, <= 0, or wrong-typed
// values are treated as ABSENT and fall through to the next tier).

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigStore } from '../lib/config-store.js';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clauge-config-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore(env = {}) {
  return new ConfigStore({ filePath: join(dir, 'config.json'), env });
}

async function writeConfig(contents) {
  await writeFile(join(dir, 'config.json'), contents);
}

describe('effectiveSubscriptionCost — default tier', () => {
  it('returns 200 when no file and no env', async () => {
    assert.equal(await makeStore({}).effectiveSubscriptionCost(), 200);
  });
});

describe('effectiveSubscriptionCost — env tier', () => {
  it('uses a valid numeric env string', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('treats a non-numeric env string as absent (falls to 200)', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: 'abc' }).effectiveSubscriptionCost(), 200);
  });

  it('treats env "0" as absent', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '0' }).effectiveSubscriptionCost(), 200);
  });

  it('treats a negative env value as absent', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '-5' }).effectiveSubscriptionCost(), 200);
  });

  it('treats env "Infinity" as absent (non-finite)', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: 'Infinity' }).effectiveSubscriptionCost(), 200);
  });

  it('treats an empty env string as absent', async () => {
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '' }).effectiveSubscriptionCost(), 200);
  });
});

describe('effectiveSubscriptionCost — file tier', () => {
  it('file value beats env and default', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 120 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 120);
  });

  it('file 0 is treated absent — falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 0 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('file negative is treated absent — falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: -3 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('file STRING "250" is treated absent (no coercion of hand-edits) — falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: '250' }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('file with missing key falls to env', async () => {
    await writeConfig(JSON.stringify({ v: 1 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('corrupt JSON file is treated absent — falls to env', async () => {
    await writeConfig('{ this is not json');
    assert.equal(await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(), 150);
  });

  it('invalid file AND invalid env fall all the way to 200', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: -1 }));
    assert.equal(await makeStore({ SUBSCRIPTION_COST: 'nope' }).effectiveSubscriptionCost(), 200);
  });
});

describe('setSubscriptionCost', () => {
  it('rejects non-finite, non-positive, and non-number values', async () => {
    const store = makeStore({});
    for (const bad of [0, -1, NaN, Infinity, -Infinity, '150', null, undefined]) {
      await assert.rejects(
        () => store.setSubscriptionCost(bad),
        /finite number > 0/,
        `expected rejection for ${String(bad)}`
      );
    }
  });

  it('writes {"v":1,"subscriptionCost":n} and a fresh instance rereads it (file beats env)', async () => {
    const store = makeStore({ SUBSCRIPTION_COST: '150' });
    await store.setSubscriptionCost(120);

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk, { v: 1, subscriptionCost: 120 });

    assert.equal(await store.effectiveSubscriptionCost(), 120, 'same instance');
    assert.equal(
      await makeStore({ SUBSCRIPTION_COST: '150' }).effectiveSubscriptionCost(),
      120,
      'fresh instance rereads the persisted value'
    );
  });

  it('leaves no .tmp file behind (atomic tmp + rename)', async () => {
    await makeStore({}).setSubscriptionCost(99);
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['config.json']);
  });

  it('creates the parent directory when missing', async () => {
    const nested = new ConfigStore({
      filePath: join(dir, 'deeper', '.clauge', 'config.json'),
      env: {},
    });
    await nested.setSubscriptionCost(42);
    assert.equal(await nested.effectiveSubscriptionCost(), 42);
  });
});

// ── Read-merge-write refactor: subscriptionCost and alerts must coexist ──
// Today setSubscriptionCost rewrites the whole file ({v:1,subscriptionCost}).
// After the refactor, a write to either key must preserve the other.
describe('read-merge-write — subscriptionCost and alerts coexist', () => {
  it('setSubscriptionCost preserves an existing alerts block', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        subscriptionCost: 200,
        alerts: { enabled: false, types: { approaching: false, willHit: true, limitReached: true } },
      })
    );
    const store = makeStore({});
    await store.setSubscriptionCost(120);

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.subscriptionCost, 120, 'cost updated');
    assert.deepEqual(
      onDisk.alerts,
      { enabled: false, types: { approaching: false, willHit: true, limitReached: true } },
      'alerts block untouched by a cost write'
    );
  });

  it('setAlertPrefs preserves an existing subscriptionCost', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 150 }));
    const store = makeStore({ SUBSCRIPTION_COST: '999' });
    await store.setAlertPrefs({ enabled: false });

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(onDisk.subscriptionCost, 150, 'cost preserved by an alerts write');
    assert.equal(await store.effectiveSubscriptionCost(), 150, 'file cost still wins over env');
  });
});

describe('effectiveAlertPrefs — defaults all-on', () => {
  it('returns all-on when no file exists', async () => {
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
  });

  it('returns all-on when the file has no alerts block', async () => {
    await writeConfig(JSON.stringify({ v: 1, subscriptionCost: 200 }));
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
  });

  it('returns all-on when the file is corrupt JSON', async () => {
    await writeConfig('{ not json at all');
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: true },
    });
  });

  it('reflects a fully specified alerts block', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        subscriptionCost: 200,
        alerts: { enabled: false, types: { approaching: false, willHit: false, limitReached: true } },
      })
    );
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: false,
      types: { approaching: false, willHit: false, limitReached: true },
    });
  });

  it('coerces a non-boolean flag to the default true (per-flag)', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        alerts: { enabled: 'yes', types: { approaching: 1, willHit: false, limitReached: null } },
      })
    );
    // enabled 'yes' -> non-boolean -> default true; approaching 1 -> true;
    // willHit false -> false (a real boolean is honored); limitReached null -> true.
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: false, limitReached: true },
    });
  });

  it('fills missing per-type flags with true', async () => {
    await writeConfig(
      JSON.stringify({ v: 1, alerts: { enabled: true, types: { willHit: false } } })
    );
    assert.deepEqual(await makeStore({}).effectiveAlertPrefs(), {
      alertsEnabled: true,
      types: { approaching: true, willHit: false, limitReached: true },
    });
  });
});

describe('setAlertPrefs — merge, validate, return effective', () => {
  it('toggling one type preserves the others', async () => {
    await writeConfig(
      JSON.stringify({
        v: 1,
        alerts: { enabled: true, types: { approaching: true, willHit: true, limitReached: true } },
      })
    );
    const store = makeStore({});
    const eff = await store.setAlertPrefs({ types: { willHit: false } });
    assert.deepEqual(eff, {
      alertsEnabled: true,
      types: { approaching: true, willHit: false, limitReached: true },
    });

    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.alerts.types, { approaching: true, willHit: false, limitReached: true });
  });

  it('resolves a sparse pre-existing types block to the full defaulted shape on write', async () => {
    // Pre-existing file omits two type flags; setAlertPrefs merges against the
    // resolved (all-on) view, so the persisted block carries all three.
    await writeConfig(
      JSON.stringify({ v: 1, alerts: { enabled: true, types: { approaching: false } } })
    );
    await makeStore({}).setAlertPrefs({ types: { willHit: false } });
    const onDisk = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(onDisk.alerts.types, {
      approaching: false,
      willHit: false,
      limitReached: true,
    });
  });

  it('a fresh instance rereads the persisted alert prefs', async () => {
    await makeStore({}).setAlertPrefs({ enabled: false });
    const eff = await makeStore({}).effectiveAlertPrefs();
    assert.equal(eff.alertsEnabled, false);
  });

  it('rejects a non-boolean enabled', async () => {
    await assert.rejects(
      () => makeStore({}).setAlertPrefs({ enabled: 'on' }),
      /boolean/,
      'enabled must be a boolean'
    );
  });

  it('rejects a non-boolean type flag', async () => {
    await assert.rejects(
      () => makeStore({}).setAlertPrefs({ types: { approaching: 1 } }),
      /boolean/,
      'type flags must be booleans'
    );
  });

  it('leaves no .tmp file behind (atomic tmp + rename)', async () => {
    await makeStore({}).setAlertPrefs({ enabled: true });
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['config.json']);
  });
});
