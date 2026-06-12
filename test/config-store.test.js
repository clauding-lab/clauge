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
