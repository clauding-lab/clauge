import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SAMPLE_INTERVAL_MS,
  RETENTION_DAYS,
  UsageHistory,
  resetsAtDriftWarning,
} from '../lib/usage-history.js';
import { WINDOW_KEYS } from '../lib/projection.js';

let TMP;

before(async () => {
  TMP = await mkdtemp(join(tmpdir(), 'clauge-usage-history-'));
});
after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

// Fixed, injected clock — never Date.now() (house rule).
const T0_ISO = '2026-06-12T10:00:00.000Z';
const T0_MS = Date.parse(T0_ISO);
const atIso = (offsetMs) => new Date(T0_MS + offsetMs).toISOString();

const NORMALIZED = {
  fiveHour: { pct: 13, resetsAt: '2026-06-12T14:20:00+00:00' },
  sevenDay: { pct: 59, resetsAt: '2026-06-17T23:00:00+00:00' },
  sevenDaySonnet: { pct: 31, resetsAt: '2026-06-17T23:00:00+00:00' },
  sevenDayOpus: { pct: 12, resetsAt: '2026-06-17T23:00:00+00:00' },
  claudeDesign: null,
  dailyRoutines: null,
  // Everything below must be EXCLUDED from the written line:
  sevenDayOmelette: { pct: 9, resetsAt: '2026-06-17T23:00:00+00:00' },
  sevenDayCowork: { pct: 7, resetsAt: '2026-06-17T23:00:00+00:00' },
  unknownSevenDayKeys: ['seven_day_aubergine'],
  extraUsage: { enabled: true, limitDollars: 20, usedDollars: 3 },
};

async function readLines(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return raw.split('\n').filter((l) => l.trim() !== '');
}

describe('constants', () => {
  it('pins the spec values', () => {
    assert.equal(SAMPLE_INTERVAL_MS, 300000);
    assert.equal(RETENTION_DAYS, 90);
  });
});

describe('UsageHistory.record — downsample gate', () => {
  it('always appends the first record', async () => {
    const file = join(TMP, 'first.jsonl');
    const h = new UsageHistory({ filePath: file });
    assert.equal(await h.record(NORMALIZED, T0_ISO), true);
    const lines = await readLines(file);
    assert.equal(lines.length, 1);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj.v, 1);
    assert.equal(obj.at, T0_ISO);
    assert.equal(obj.w.fiveHour.pct, 13);
    assert.equal(obj.w.fiveHour.resetsAt, '2026-06-12T14:20:00+00:00');
  });

  it('skips a second record within 5 minutes', async () => {
    const file = join(TMP, 'gate.jsonl');
    const h = new UsageHistory({ filePath: file });
    assert.equal(await h.record(NORMALIZED, T0_ISO), true);
    assert.equal(await h.record(NORMALIZED, atIso(4 * 60000)), false);
    assert.equal((await readLines(file)).length, 1);
  });

  it('appends again at exactly 5 minutes (gate is strict less-than)', async () => {
    const file = join(TMP, 'gate-eq.jsonl');
    const h = new UsageHistory({ filePath: file });
    assert.equal(await h.record(NORMALIZED, T0_ISO), true);
    assert.equal(await h.record(NORMALIZED, atIso(SAMPLE_INTERVAL_MS)), true);
    assert.equal((await readLines(file)).length, 2);
  });

  it('cold start reads the last line from disk (restart within 5 min stays gated)', async () => {
    const file = join(TMP, 'cold.jsonl');
    const a = new UsageHistory({ filePath: file });
    assert.equal(await a.record(NORMALIZED, T0_ISO), true);
    // Fresh instance, same file — simulates a sidecar restart.
    const b = new UsageHistory({ filePath: file });
    assert.equal(await b.record(NORMALIZED, atIso(2 * 60000)), false);
    assert.equal(await b.record(NORMALIZED, atIso(6 * 60000)), true);
    assert.equal((await readLines(file)).length, 2);
  });
});

describe('UsageHistory.record — window allowlist', () => {
  it('writes only the resolved non-null windows; codenames + non-window fields excluded', async () => {
    const file = join(TMP, 'allowlist.jsonl');
    const h = new UsageHistory({ filePath: file });
    await h.record(NORMALIZED, T0_ISO);
    const obj = JSON.parse((await readLines(file))[0]);
    assert.deepEqual(Object.keys(obj.w).sort(), [
      'fiveHour',
      'sevenDay',
      'sevenDayOpus',
      'sevenDaySonnet',
    ]);
    // null windows omitted:
    assert.equal('claudeDesign' in obj.w, false);
    assert.equal('dailyRoutines' in obj.w, false);
    // legacy codenames + non-window fields NEVER written:
    assert.equal('sevenDayOmelette' in obj.w, false);
    assert.equal('sevenDayCowork' in obj.w, false);
    assert.equal('extraUsage' in obj.w, false);
    assert.equal('unknownSevenDayKeys' in obj.w, false);
    assert.equal('unknownSevenDayKeys' in obj, false);
  });
});

describe('UsageHistory.record — never throws', () => {
  it(
    'resolves false and console.warn-s on an unwritable directory',
    // POSIX dir permissions (chmod 0o500) are not enforced on Windows — appendFile
    // succeeds there, so this EACCES path is POSIX-only. The graceful-failure
    // behaviour stays covered on macOS + Linux CI. (Surfaced in the v1.3.0 release:
    // PR CI is macOS-only, so this only failed on the release's Windows matrix job.)
    { skip: process.platform === 'win32' ? 'chmod dir perms not enforced on Windows' : false },
    async (t) => {
    const lockedDir = join(TMP, 'locked');
    await mkdir(lockedDir, { recursive: true });
    await chmod(lockedDir, 0o500); // r-x: appendFile will EACCES
    t.after(async () => chmod(lockedDir, 0o700)); // so cleanup can rm it
    const warn = t.mock.method(console, 'warn', () => {});
    const h = new UsageHistory({ filePath: join(lockedDir, 'h.jsonl') });
    const appended = await h.record(NORMALIZED, T0_ISO); // must not throw
    assert.equal(appended, false);
    assert.ok(warn.mock.callCount() >= 1, 'console.warn fired');
    assert.match(
      String(warn.mock.calls[0].arguments[0]),
      /usage-history: failed to record/
    );
  });
});

describe('UsageHistory.samplesFor', () => {
  it('returns oldest-first {at, pct, resetsAt} for a key; [] for unknown keys', async () => {
    const file = join(TMP, 'samples.jsonl');
    const h = new UsageHistory({ filePath: file });
    await h.record(NORMALIZED, T0_ISO);
    await h.record(
      { ...NORMALIZED, fiveHour: { pct: 21, resetsAt: '2026-06-12T14:20:00+00:00' } },
      atIso(10 * 60000)
    );
    const samples = await h.samplesFor('fiveHour');
    assert.deepEqual(samples, [
      { at: T0_ISO, pct: 13, resetsAt: '2026-06-12T14:20:00+00:00' },
      { at: atIso(10 * 60000), pct: 21, resetsAt: '2026-06-12T14:20:00+00:00' },
    ]);
    assert.deepEqual(await h.samplesFor('sevenDayOmelette'), []);
    assert.deepEqual(await h.samplesFor('nonsense'), []);
  });

  it('returns [] for a missing file', async () => {
    const h = new UsageHistory({ filePath: join(TMP, 'no-such-file.jsonl') });
    assert.deepEqual(await h.samplesFor('fiveHour'), []);
  });

  it('skips corrupt lines and wrong-v lines, keeps valid ones', async () => {
    const file = join(TMP, 'tolerant.jsonl');
    const good1 = JSON.stringify({
      v: 1,
      at: T0_ISO,
      w: { fiveHour: { pct: 10, resetsAt: '2026-06-12T14:20:00+00:00' } },
    });
    const corrupt = '{"v":1,"at":"2026-06-12T10:0'; // truncated mid-write
    const wrongV = JSON.stringify({
      v: 2,
      at: atIso(5 * 60000),
      w: { fiveHour: { pct: 11, resetsAt: '2026-06-12T14:20:00+00:00' } },
    });
    const good2 = JSON.stringify({
      v: 1,
      at: atIso(10 * 60000),
      w: { fiveHour: { pct: 12, resetsAt: '2026-06-12T14:20:00+00:00' } },
    });
    await writeFile(file, [good1, corrupt, wrongV, good2].join('\n') + '\n');
    const samples = await (new UsageHistory({ filePath: file })).samplesFor('fiveHour');
    assert.deepEqual(
      samples.map((s) => s.pct),
      [10, 12]
    );
  });
});

describe('UsageHistory.samplesByWindow', () => {
  it('reads the file once and buckets every window into one oldest-first map', async () => {
    const file = join(TMP, 'by-window.jsonl');
    const h = new UsageHistory({ filePath: file });
    await h.record(NORMALIZED, T0_ISO);
    await h.record(
      {
        ...NORMALIZED,
        fiveHour: { pct: 21, resetsAt: '2026-06-12T14:20:00+00:00' },
        sevenDay: { pct: 60, resetsAt: '2026-06-17T23:00:00+00:00' },
      },
      atIso(10 * 60000)
    );
    const map = await h.samplesByWindow();
    // A (possibly empty) array per canonical window key, and equivalent to
    // samplesFor for each populated key.
    assert.deepEqual(map.fiveHour, await h.samplesFor('fiveHour'));
    assert.deepEqual(map.sevenDay, await h.samplesFor('sevenDay'));
    assert.deepEqual(map.fiveHour.map((s) => s.pct), [13, 21]);
    // Every canonical key present; legacy/non-window keys never appear.
    assert.deepEqual(Object.keys(map).sort(), [...WINDOW_KEYS].sort());
    assert.equal(map.sevenDayOmelette, undefined);
  });

  it('returns all-empty arrays for a missing file', async () => {
    const h = new UsageHistory({ filePath: join(TMP, 'no-such-by-window.jsonl') });
    const map = await h.samplesByWindow();
    assert.deepEqual(Object.keys(map).sort(), [...WINDOW_KEYS].sort());
    for (const key of WINDOW_KEYS) assert.deepEqual(map[key], []);
  });
});

describe('UsageHistory.prune', () => {
  it('drops >90-day-old lines via atomic rewrite and leaves no .tmp file', async () => {
    const file = join(TMP, 'prune.jsonl');
    const oldLine = JSON.stringify({
      v: 1,
      at: new Date(T0_MS - 100 * 86400000).toISOString(), // 100 days old
      w: { fiveHour: { pct: 5, resetsAt: '2026-03-04T14:20:00+00:00' } },
    });
    const freshLine = JSON.stringify({
      v: 1,
      at: new Date(T0_MS - 1 * 86400000).toISOString(), // 1 day old
      w: { fiveHour: { pct: 50, resetsAt: '2026-06-11T14:20:00+00:00' } },
    });
    await writeFile(file, oldLine + '\n' + freshLine + '\n');
    const h = new UsageHistory({ filePath: file });
    await h.prune(T0_MS);
    const lines = await readLines(file);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).w.fiveHour.pct, 50);
    await assert.rejects(access(file + '.tmp'), 'no .tmp leftover after rename');
  });

  it('is a no-op when nothing is older than the retention window', async () => {
    const file = join(TMP, 'prune-noop.jsonl');
    const freshLine = JSON.stringify({
      v: 1,
      at: T0_ISO,
      w: { fiveHour: { pct: 50, resetsAt: '2026-06-12T14:20:00+00:00' } },
    });
    await writeFile(file, freshLine + '\n');
    const h = new UsageHistory({ filePath: file });
    await h.prune(T0_MS);
    assert.equal((await readLines(file)).length, 1);
    await assert.rejects(access(file + '.tmp'));
  });

  it('silently returns when the file does not exist', async () => {
    const h = new UsageHistory({ filePath: join(TMP, 'prune-missing.jsonl') });
    await h.prune(T0_MS); // must not throw
  });
});

describe('resetsAtDriftWarning (pure tripwire)', () => {
  it('fires when resetsAt moved 5min<delta<1h while pct rose', () => {
    const calls = [];
    const fired = resetsAtDriftWarning(
      'fiveHour',
      { pct: 40, resetsAt: '2026-06-12T14:20:00+00:00' },
      { pct: 45, resetsAt: '2026-06-12T14:50:00+00:00' }, // +30 min
      (msg) => calls.push(msg)
    );
    assert.equal(fired, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\[Clauge] resetsAt-drift/);
    assert.match(calls[0], /"fiveHour"/);
  });

  it('does NOT fire when the delta is within the 5-minute tolerance', () => {
    const calls = [];
    const fired = resetsAtDriftWarning(
      'fiveHour',
      { pct: 40, resetsAt: '2026-06-12T14:20:00+00:00' },
      { pct: 45, resetsAt: '2026-06-12T14:22:00+00:00' }, // +2 min
      (msg) => calls.push(msg)
    );
    assert.equal(fired, false);
    assert.equal(calls.length, 0);
  });

  it('does NOT fire when the delta is 1h or more (real window change)', () => {
    const calls = [];
    const fired = resetsAtDriftWarning(
      'fiveHour',
      { pct: 40, resetsAt: '2026-06-12T14:20:00+00:00' },
      { pct: 45, resetsAt: '2026-06-12T19:20:00+00:00' }, // +5 h
      (msg) => calls.push(msg)
    );
    assert.equal(fired, false);
  });

  it('does NOT fire when pct fell (a reset, not drift)', () => {
    const calls = [];
    const fired = resetsAtDriftWarning(
      'fiveHour',
      { pct: 90, resetsAt: '2026-06-12T14:20:00+00:00' },
      { pct: 3, resetsAt: '2026-06-12T14:50:00+00:00' },
      (msg) => calls.push(msg)
    );
    assert.equal(fired, false);
  });
});

describe('UsageHistory drift tripwire — once per window per process', () => {
  it('warns on the first ambiguous-zone pair only', async (t) => {
    const file = join(TMP, 'drift.jsonl');
    const warn = t.mock.method(console, 'warn', () => {});
    const h = new UsageHistory({ filePath: file });
    const win = (pct, resetsAt) => ({
      ...NORMALIZED,
      fiveHour: { pct, resetsAt },
    });
    await h.record(win(40, '2026-06-12T14:20:00+00:00'), T0_ISO);
    // +30 min resetsAt drift while pct rose -> ambiguous zone -> warn
    await h.record(win(45, '2026-06-12T14:50:00+00:00'), atIso(5 * 60000));
    // Another ambiguous pair for the SAME window -> must NOT warn again
    await h.record(win(50, '2026-06-12T15:20:00+00:00'), atIso(10 * 60000));
    const driftCalls = warn.mock.calls.filter((c) =>
      String(c.arguments[0]).includes('resetsAt-drift')
    );
    assert.equal(driftCalls.length, 1);
    assert.match(String(driftCalls[0].arguments[0]), /"fiveHour"/);
  });
});
