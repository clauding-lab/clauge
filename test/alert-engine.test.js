// Unit tests for lib/alert-engine.js — pure desktop alert engine
// (Component 1, docs/superpowers/specs/2026-06-12-desktop-alerts-tray-design.md).
// Clock pinned via NOW_MS; projection built through the real buildProjection
// so window state + freshness.stale come from the actual A engine.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProjection } from '../lib/projection.js';
import {
  WATCHED_WINDOWS,
  APPROACHING_LEVELS,
  SEVERITY,
  windowLabel,
  evaluate,
} from '../lib/alert-engine.js';

// 2026-06-12T10:00:00.000Z — same clock family as projection.test.js.
const NOW_MS = 1781258400000;

// resetsAt strings (all FUTURE relative to NOW_MS unless noted).
const FIVE_RESET = '2026-06-12T14:20:00+00:00'; // ~4h20m out
const SEVEN_RESET = '2026-06-14T12:24:00+00:00'; // ~2d out
const PAST_RESET = '2026-06-12T05:00:00+00:00'; // already reset

const ALL_ON = {
  alertsEnabled: true,
  types: { approaching: true, willHit: true, limitReached: true },
};

// Per-window history that pins the projection STATE the engine reads. The
// real projectWindow extrapolates the window-average rate when no history is
// given, and at NOW_MS the watched windows are only minutes old — so the avg
// rate reports will_hit at almost any pct. To exercise the engine's
// approaching/willHit branches independently we supply an explicit recent
// sample per window: a near-flat one yields a `safe` forecast (so willHit is
// NOT a candidate and approaching wins), a steep one yields `will_hit`.
// History only changes projection.state; the engine reads .state + .stale.

// Near-flat: pct barely moved over the last 30 min => recent rate ~0 => safe.
function flatHistory(normalized) {
  const at = new Date(NOW_MS - 30 * 60000).toISOString();
  const history = {};
  for (const [key, win] of Object.entries(normalized ?? {})) {
    if (win?.resetsAt == null || !Number.isFinite(win?.pct)) continue;
    history[key] = [{ at, pct: win.pct, resetsAt: win.resetsAt }];
  }
  return history;
}

// Steep: pct climbed sharply over the last 30 min => recent rate high =>
// will_hit. samplePct sits well below the current pct for every window.
function steepHistory(normalized) {
  const at = new Date(NOW_MS - 30 * 60000).toISOString();
  const history = {};
  for (const [key, win] of Object.entries(normalized ?? {})) {
    if (win?.resetsAt == null || !Number.isFinite(win?.pct)) continue;
    history[key] = [
      { at, pct: Math.max(0, win.pct - 40), resetsAt: win.resetsAt },
    ];
  }
  return history;
}

// Build a fresh (non-stale) projection from a normalized plan. ingestedAt =
// now keeps freshness.stale false. `history` pins each window's forecast
// state (default flat => safe; the willHit cases pass steepHistory).
function freshProjection(normalized, history = flatHistory(normalized)) {
  return buildProjection({
    normalized,
    ingestedAt: new Date(NOW_MS).toISOString(),
    history,
    nowMs: NOW_MS,
    apiEquivalentSpendTrailing: 0,
    subscriptionCost: 200,
  });
}

// Force every window stale by making the ingest old.
function staleProjection(normalized) {
  return buildProjection({
    normalized,
    ingestedAt: '2026-06-12T09:00:00+00:00', // 60 min old > 10 min
    history: null,
    nowMs: NOW_MS,
    apiEquivalentSpendTrailing: 0,
    subscriptionCost: 200,
  });
}

function evalWith({ usage, prefs = ALL_ON, fired = new Set() }) {
  const projection = freshProjection(usage);
  return evaluate({ usage, projection, prefs, fired, nowMs: NOW_MS });
}

function ids(alerts) {
  return alerts.map((a) => a.id);
}

describe('exports — pinned contract', () => {
  it('WATCHED_WINDOWS is the two hero windows', () => {
    assert.deepEqual(WATCHED_WINDOWS, ['fiveHour', 'sevenDay']);
  });
  it('APPROACHING_LEVELS descending', () => {
    assert.deepEqual(APPROACHING_LEVELS, [95, 80]);
  });
  it('SEVERITY ranks', () => {
    assert.equal(SEVERITY.limitReached, 4);
    assert.equal(SEVERITY.willHit, 3);
    assert.equal(SEVERITY.approaching95, 2);
    assert.equal(SEVERITY.approaching80, 1);
  });
  it('windowLabel maps the two windows', () => {
    assert.equal(windowLabel('fiveHour'), '5-hour');
    assert.equal(windowLabel('sevenDay'), 'weekly');
  });
});

describe('approaching thresholds — inclusive boundaries', () => {
  it('pct exactly 80 fires approaching:80', () => {
    const usage = { fiveHour: { pct: 80, resetsAt: FIVE_RESET } };
    const { due, retire } = evalWith({ usage });
    assert.deepEqual(ids(due), [`approaching:fiveHour:80:${FIVE_RESET}`]);
    assert.equal(due[0].type, 'approaching');
    assert.equal(due[0].level, 80);
    assert.equal(due[0].window, 'fiveHour');
    assert.deepEqual(retire, []);
  });

  it('pct just under 80 fires nothing', () => {
    const usage = { fiveHour: { pct: 79.9, resetsAt: FIVE_RESET } };
    const { due, retire } = evalWith({ usage });
    assert.deepEqual(due, []);
    assert.deepEqual(retire, []);
  });

  it('pct exactly 95 fires approaching:95 and retires the unfired :80', () => {
    const usage = { fiveHour: { pct: 95, resetsAt: FIVE_RESET } };
    const { due, retire } = evalWith({ usage });
    assert.deepEqual(ids(due), [`approaching:fiveHour:95:${FIVE_RESET}`]);
    assert.equal(due[0].level, 95);
    assert.deepEqual(retire, [`approaching:fiveHour:80:${FIVE_RESET}`]);
  });
});

describe('limitReached — pct >= 100 (inclusive), not state===exhausted', () => {
  it('pct exactly 100 fires limitReached and retires all lower keys', () => {
    const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
    const { due, retire } = evalWith({ usage });
    assert.deepEqual(ids(due), [`limitReached:fiveHour:${FIVE_RESET}`]);
    assert.equal(due[0].type, 'limitReached');
    assert.deepEqual(retire.sort(), [
      `approaching:fiveHour:80:${FIVE_RESET}`,
      `approaching:fiveHour:95:${FIVE_RESET}`,
      `willHit:fiveHour:${FIVE_RESET}`,
    ].sort());
  });

  it('past-resetsAt at 100 still fires limitReached via the pct clause (projection state unavailable)', () => {
    const usage = { fiveHour: { pct: 100, resetsAt: PAST_RESET } };
    const projection = freshProjection(usage);
    // projection.windows.fiveHour.state is 'unavailable' (resetsAt <= nowMs),
    // NOT 'exhausted' — limitReached must still fire off the pct clause.
    assert.equal(projection.windows.fiveHour.state, 'unavailable');
    const { due } = evaluate({
      usage,
      projection,
      prefs: ALL_ON,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(ids(due), [`limitReached:fiveHour:${PAST_RESET}`]);
  });
});

describe('willHit', () => {
  it('fires when projection state is will_hit and retires the unfired approaching keys', () => {
    // pct 90 with a steep recent rate -> projects past 100 before reset
    // => state will_hit.
    const usage = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
    const projection = freshProjection(usage, steepHistory(usage));
    assert.equal(projection.windows.fiveHour.state, 'will_hit');
    const { due, retire } = evaluate({
      usage,
      projection,
      prefs: ALL_ON,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(ids(due), [`willHit:fiveHour:${FIVE_RESET}`]);
    assert.deepEqual(retire.sort(), [
      `approaching:fiveHour:80:${FIVE_RESET}`,
      `approaching:fiveHour:95:${FIVE_RESET}`,
    ].sort());
  });

  it('fires independently on the sevenDay window (per-window symmetry)', () => {
    // Same forecast/collapse path must work on the OTHER watched window.
    const usage = { sevenDay: { pct: 90, resetsAt: SEVEN_RESET } };
    const projection = freshProjection(usage, steepHistory(usage));
    assert.equal(projection.windows.sevenDay.state, 'will_hit');
    const { due, retire } = evaluate({
      usage,
      projection,
      prefs: ALL_ON,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(ids(due), [`willHit:sevenDay:${SEVEN_RESET}`]);
    assert.deepEqual(retire.sort(), [
      `approaching:sevenDay:80:${SEVEN_RESET}`,
      `approaching:sevenDay:95:${SEVEN_RESET}`,
    ].sort());
  });
});

describe('dedup — key already in fired does not re-fire', () => {
  it('approaching:80 in fired -> nothing due', () => {
    const usage = { fiveHour: { pct: 82, resetsAt: FIVE_RESET } };
    const fired = new Set([`approaching:fiveHour:80:${FIVE_RESET}`]);
    const { due, retire } = evalWith({ usage, fired });
    assert.deepEqual(due, []);
    assert.deepEqual(retire, []);
  });
});

describe('re-arm on changed resetsAt (new window instance)', () => {
  it('the OLD resetsAt key in fired does not suppress the NEW instance', () => {
    const NEW_RESET = '2026-06-12T19:20:00+00:00';
    const usage = { fiveHour: { pct: 82, resetsAt: NEW_RESET } };
    const fired = new Set([`approaching:fiveHour:80:${FIVE_RESET}`]); // old
    const { due } = evalWith({ usage, fired });
    assert.deepEqual(ids(due), [`approaching:fiveHour:80:${NEW_RESET}`]);
  });
});

describe('forward-looking collapse across ticks (intra-instance)', () => {
  it('willHit fires + retires approaching keys; a later 96% tick yields due=[] while limitReached stays armed', () => {
    // Tick 1: willHit at pct 90 (steep recent rate => will_hit).
    const usage1 = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
    const proj1 = freshProjection(usage1, steepHistory(usage1));
    const r1 = evaluate({
      usage: usage1,
      projection: proj1,
      prefs: ALL_ON,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(ids(r1.due), [`willHit:fiveHour:${FIVE_RESET}`]);

    // Persist what Rust would ack: due ids + retired ids -> fired set.
    const fired = new Set([...ids(r1.due), ...r1.retire]);

    // Tick 2: pct climbs to 96 (>=95). approaching:95 is already retired,
    // so it must NOT fire; limitReached was never retired -> stays armed
    // (condition not yet met at 96, so nothing due).
    const usage2 = { fiveHour: { pct: 96, resetsAt: FIVE_RESET } };
    const proj2 = freshProjection(usage2);
    const r2 = evaluate({
      usage: usage2,
      projection: proj2,
      prefs: ALL_ON,
      fired,
      nowMs: NOW_MS,
    });
    assert.deepEqual(r2.due, []);
    assert.deepEqual(r2.retire, []);

    // Tick 3: pct 100 -> limitReached still armed, so it fires.
    const usage3 = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
    const proj3 = freshProjection(usage3);
    const r3 = evaluate({
      usage: usage3,
      projection: proj3,
      prefs: ALL_ON,
      fired,
      nowMs: NOW_MS,
    });
    assert.deepEqual(ids(r3.due), [`limitReached:fiveHour:${FIVE_RESET}`]);
  });
});

describe('stale gate', () => {
  it('stale + pct 100 + future resetsAt -> limitReached due (+ lower retired)', () => {
    const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
    const projection = staleProjection(usage);
    assert.equal(projection.freshness.stale, true);
    const { due, retire } = evaluate({
      usage,
      projection,
      prefs: ALL_ON,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(ids(due), [`limitReached:fiveHour:${FIVE_RESET}`]);
    // willHit + both approaching keys are suppressed-but-retired.
    assert.deepEqual(retire.sort(), [
      `approaching:fiveHour:80:${FIVE_RESET}`,
      `approaching:fiveHour:95:${FIVE_RESET}`,
      `willHit:fiveHour:${FIVE_RESET}`,
    ].sort());
  });

  it('stale + pct 100 + PAST resetsAt -> nothing (stale post-reset 100 is not live)', () => {
    const usage = { fiveHour: { pct: 100, resetsAt: PAST_RESET } };
    const projection = staleProjection(usage);
    const { due, retire } = evaluate({
      usage,
      projection,
      prefs: ALL_ON,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(due, []);
    assert.deepEqual(retire, []);
  });

  it('stale suppresses willHit + approaching (pct 90, future reset, not at 100)', () => {
    const usage = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
    const projection = staleProjection(usage);
    const { due, retire } = evaluate({
      usage,
      projection,
      prefs: ALL_ON,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(due, []);
    assert.deepEqual(retire, []);
  });
});

describe('gating', () => {
  it('master off -> empty', () => {
    const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
    const prefs = {
      alertsEnabled: false,
      types: { approaching: true, willHit: true, limitReached: true },
    };
    const { due, retire } = evalWith({ usage, prefs });
    assert.deepEqual(due, []);
    assert.deepEqual(retire, []);
  });

  it('a disabled type is NOT retired by a higher fire', () => {
    // approaching OFF; limitReached fires at 100. approaching:80/:95 must
    // NOT appear in retire (the user turned them off — not "spent").
    const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
    const prefs = {
      alertsEnabled: true,
      types: { approaching: false, willHit: true, limitReached: true },
    };
    const { due, retire } = evalWith({ usage, prefs });
    assert.deepEqual(ids(due), [`limitReached:fiveHour:${FIVE_RESET}`]);
    assert.deepEqual(retire, [`willHit:fiveHour:${FIVE_RESET}`]);
  });

  it('disabled limitReached: the next type down (willHit) becomes H', () => {
    const usage = { fiveHour: { pct: 90, resetsAt: FIVE_RESET } };
    const prefs = {
      alertsEnabled: true,
      types: { approaching: true, willHit: true, limitReached: false },
    };
    const projection = freshProjection(usage, steepHistory(usage));
    assert.equal(projection.windows.fiveHour.state, 'will_hit');
    const { due } = evaluate({
      usage,
      projection,
      prefs,
      fired: new Set(),
      nowMs: NOW_MS,
    });
    assert.deepEqual(ids(due), [`willHit:fiveHour:${FIVE_RESET}`]);
  });
});

describe('both watched windows in one pass', () => {
  it('each window evaluated independently', () => {
    const usage = {
      fiveHour: { pct: 100, resetsAt: FIVE_RESET },
      sevenDay: { pct: 82, resetsAt: SEVEN_RESET },
    };
    const { due } = evalWith({ usage });
    assert.deepEqual(ids(due).sort(), [
      `approaching:sevenDay:80:${SEVEN_RESET}`,
      `limitReached:fiveHour:${FIVE_RESET}`,
    ].sort());
  });
});

describe('null / missing window -> skipped', () => {
  it('resetsAt null skips the window', () => {
    const usage = { fiveHour: { pct: 100, resetsAt: null } };
    const { due, retire } = evalWith({ usage });
    assert.deepEqual(due, []);
    assert.deepEqual(retire, []);
  });

  it('window entirely absent is skipped', () => {
    const usage = { sevenDay: { pct: 82, resetsAt: SEVEN_RESET } };
    const { due } = evalWith({ usage });
    assert.deepEqual(ids(due), [`approaching:sevenDay:80:${SEVEN_RESET}`]);
  });
});

describe('alert bodies use local time', () => {
  it('body contains the local-time string for resetsAt', () => {
    const usage = { fiveHour: { pct: 100, resetsAt: FIVE_RESET } };
    const { due } = evalWith({ usage });
    const expected = new Date(FIVE_RESET).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    assert.ok(
      due[0].body.includes(expected),
      `body "${due[0].body}" should contain "${expected}"`
    );
    assert.ok(due[0].title.includes('5-hour'));
  });
});
