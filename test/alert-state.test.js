// Unit tests for lib/alert-state.js — sidecar-owned fired-key store
// (Component 2, docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md).
// Atomic tmp+rename persistence (mirrors lib/config-store.js); load() prunes
// keys whose embedded resetsAt has already passed; missing/corrupt -> empty.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AlertState } from '../lib/alert-state.js';

// 2026-06-12T10:00:00.000Z
const NOW_MS = 1781258400000;
const FUTURE = '2026-06-12T14:20:00+00:00'; // > NOW
const PAST = '2026-06-12T05:00:00+00:00'; // < NOW

const FUTURE_KEY = `approaching:fiveHour:80:${FUTURE}`;
const PAST_KEY = `approaching:fiveHour:80:${PAST}`;
const FUTURE_LIMIT_KEY = `limitReached:sevenDay:${FUTURE}`;

// #08 grace: a fired key must outlive its exact reset instant by
// SAME_WINDOW_TOLERANCE_MS (5 min) so a drift-later twin still has a
// predecessor to match. GRACE_RESET == NOW_MS, so load/markFired at NOW+4min
// (inside grace) must keep it and NOW+6min (past grace) must drop it.
const GRACE_RESET = '2026-06-12T10:00:00+00:00'; // == NOW_MS
const GRACE_KEY = `approaching:fiveHour:80:${GRACE_RESET}`;
const FOUR_MIN = 4 * 60000;
const SIX_MIN = 6 * 60000;

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clauge-alert-state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeState() {
  return new AlertState({ filePath: join(dir, 'alert-state.json') });
}

async function writeRaw(contents) {
  await writeFile(join(dir, 'alert-state.json'), contents);
}

describe('load — missing / corrupt tolerance', () => {
  it('missing file -> empty Set', async () => {
    const fired = await makeState().load(NOW_MS);
    assert.ok(fired instanceof Set);
    assert.equal(fired.size, 0);
  });

  it('corrupt JSON -> empty Set (never throws)', async () => {
    await writeRaw('{ not json at all');
    const fired = await makeState().load(NOW_MS);
    assert.equal(fired.size, 0);
  });

  it('non-array fired field -> empty Set', async () => {
    await writeRaw(JSON.stringify({ v: 1, fired: 'oops' }));
    const fired = await makeState().load(NOW_MS);
    assert.equal(fired.size, 0);
  });
});

describe('load — prune by embedded resetsAt', () => {
  it('drops keys whose resetsAt <= nowMs, keeps future ones', async () => {
    await writeRaw(
      JSON.stringify({ v: 1, fired: [FUTURE_KEY, PAST_KEY, FUTURE_LIMIT_KEY] })
    );
    const fired = await makeState().load(NOW_MS);
    assert.ok(fired.has(FUTURE_KEY));
    assert.ok(fired.has(FUTURE_LIMIT_KEY));
    assert.ok(!fired.has(PAST_KEY));
    assert.equal(fired.size, 2);
  });

  it('drops a key with an unparseable resetsAt segment', async () => {
    const bad = 'approaching:fiveHour:80:not-a-date';
    await writeRaw(JSON.stringify({ v: 1, fired: [FUTURE_KEY, bad] }));
    const fired = await makeState().load(NOW_MS);
    assert.ok(fired.has(FUTURE_KEY));
    assert.ok(!fired.has(bad));
    assert.equal(fired.size, 1);
  });
});

describe('load — reset-drift grace window (#08)', () => {
  it('keeps a key 4 min past its resetsAt (inside the 5-min grace)', async () => {
    await writeRaw(JSON.stringify({ v: 1, fired: [GRACE_KEY] }));
    const fired = await makeState().load(NOW_MS + FOUR_MIN);
    assert.ok(fired.has(GRACE_KEY));
  });

  it('drops the key 6 min past its resetsAt (beyond the grace)', async () => {
    await writeRaw(JSON.stringify({ v: 1, fired: [GRACE_KEY] }));
    const fired = await makeState().load(NOW_MS + SIX_MIN);
    assert.ok(!fired.has(GRACE_KEY));
  });
});

describe('markFired — on-write prune honours the grace window (#08)', () => {
  it('persists a key still inside the grace window', async () => {
    await makeState().markFired([GRACE_KEY], NOW_MS + FOUR_MIN);
    const onDisk = JSON.parse(
      await readFile(join(dir, 'alert-state.json'), 'utf8')
    );
    assert.ok(onDisk.fired.includes(GRACE_KEY));
  });

  it('prunes a key once it is past the grace window', async () => {
    await makeState().markFired([GRACE_KEY], NOW_MS + SIX_MIN);
    const onDisk = JSON.parse(
      await readFile(join(dir, 'alert-state.json'), 'utf8')
    );
    assert.ok(!onDisk.fired.includes(GRACE_KEY));
  });
});

describe('markFired — union + atomic persistence', () => {
  it('persists the union and a re-load reflects it', async () => {
    const state = makeState();
    await state.markFired([FUTURE_KEY], NOW_MS);
    await state.markFired([FUTURE_LIMIT_KEY, FUTURE_KEY], NOW_MS); // dup + new

    const onDisk = JSON.parse(
      await readFile(join(dir, 'alert-state.json'), 'utf8')
    );
    assert.equal(onDisk.v, 1);
    assert.deepEqual([...onDisk.fired].sort(), [FUTURE_KEY, FUTURE_LIMIT_KEY].sort());

    const fired = await makeState().load(NOW_MS);
    assert.ok(fired.has(FUTURE_KEY));
    assert.ok(fired.has(FUTURE_LIMIT_KEY));
    assert.equal(fired.size, 2);
  });

  it('prunes expired + garbage keys ON WRITE so the file is actually bounded', async () => {
    // Seed a file already carrying an expired key + an unparseable key.
    await writeRaw(
      JSON.stringify({ v: 1, fired: [PAST_KEY, 'garbage-no-iso', FUTURE_KEY] })
    );
    // Marking a new live key must drop the expired/garbage ones from DISK.
    await makeState().markFired([FUTURE_LIMIT_KEY], NOW_MS);
    const onDisk = JSON.parse(
      await readFile(join(dir, 'alert-state.json'), 'utf8')
    );
    assert.deepEqual([...onDisk.fired].sort(), [FUTURE_KEY, FUTURE_LIMIT_KEY].sort());
    assert.ok(!onDisk.fired.includes(PAST_KEY), 'expired key removed from disk');
    assert.ok(!onDisk.fired.includes('garbage-no-iso'), 'garbage key removed from disk');
  });

  it('leaves no .tmp file behind (atomic tmp + rename)', async () => {
    await makeState().markFired([FUTURE_KEY], NOW_MS);
    const entries = await readdir(dir);
    assert.deepEqual(entries, ['alert-state.json']);
  });

  it('creates the parent directory when missing', async () => {
    const nested = new AlertState({
      filePath: join(dir, 'deeper', '.clauge', 'alert-state.json'),
    });
    await nested.markFired([FUTURE_KEY], NOW_MS);
    const fired = await nested.load(NOW_MS);
    assert.ok(fired.has(FUTURE_KEY));
  });

  it('markFired with an empty array still produces a valid empty file', async () => {
    const state = makeState();
    await state.markFired([], NOW_MS);
    const onDisk = JSON.parse(
      await readFile(join(dir, 'alert-state.json'), 'utf8')
    );
    assert.deepEqual(onDisk, { v: 1, fired: [] });
  });
});
