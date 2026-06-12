import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

// Same vm seam as test/dashboard-swr.test.js: public/swr.js is a classic
// browser IIFE (window-only, no export/module.exports — the repo is
// "type":"module"), so evaluate the real shipped source in THIS realm with a
// local `window` and read back window.ClaugeDashSwr.
function loadDashSwr() {
  const path = join(import.meta.dirname, '..', 'public', 'swr.js');
  const src = readFileSync(path, 'utf8');
  const factory = vm.runInThisContext(
    `(function (window) {\n${src}\nreturn window.ClaugeDashSwr;\n})`,
    { filename: path },
  );
  return factory({});
}

const { projectionLine, wowLine, paceLine } = loadDashSwr();

// Clock formatter is INJECTED (house clock-injection convention) so the
// mapping stays pure; app.js passes its real fmtResetClock at the callsite.
const fmtClockStub = (iso) => `LOCAL(${iso})`;

describe('projectionLine — plan-card forecast text per /api/projection window state', () => {
  it('will_hit → "At this pace → 100% ~{local time}" via the injected clock formatter', () => {
    const line = projectionLine(
      { state: 'will_hit', etaAt: '2026-06-12T11:40:00.000Z', projectedEndPct: null },
      fmtClockStub,
    );
    assert.equal(line, 'At this pace → 100% ~LOCAL(2026-06-12T11:40:00.000Z)');
  });

  it('safe → "On pace to end at ~{pct}%"', () => {
    const line = projectionLine({ state: 'safe', etaAt: null, projectedEndPct: 84 }, fmtClockStub);
    assert.equal(line, 'On pace to end at ~84%');
  });

  it('exhausted → "Limit reached — resets {time}" from the payload resetsAt', () => {
    const line = projectionLine(
      { state: 'exhausted', resetsAt: '2026-06-12T14:20:00.800955+00:00' },
      fmtClockStub,
    );
    assert.equal(line, 'Limit reached — resets LOCAL(2026-06-12T14:20:00.800955+00:00)');
  });

  it('hides the line (null) for warming_up / stale / unavailable / missing window', () => {
    for (const state of ['warming_up', 'stale', 'unavailable']) {
      assert.equal(projectionLine({ state }, fmtClockStub), null);
    }
    assert.equal(projectionLine(null, fmtClockStub), null);
    assert.equal(projectionLine(undefined, fmtClockStub), null);
  });

  it('safe with a non-finite projectedEndPct hides the line (Number.isFinite guard)', () => {
    assert.equal(projectionLine({ state: 'safe', projectedEndPct: null }, fmtClockStub), null);
  });
});

describe('wowLine — week-over-week delta sign formatting', () => {
  it('positive delta gets an explicit plus sign', () => {
    assert.equal(wowLine({ deltaPts: 15, prevPctAtSamePoint: 44 }), '+15 pts vs last week');
  });
  it('negative delta keeps its minus sign', () => {
    assert.equal(wowLine({ deltaPts: -3, prevPctAtSamePoint: 62 }), '-3 pts vs last week');
  });
  it('zero delta renders with no sign', () => {
    assert.equal(wowLine({ deltaPts: 0, prevPctAtSamePoint: 59 }), '0 pts vs last week');
  });
  it('null weekOverWeek (no prior-week history / gated state) hides the line', () => {
    assert.equal(wowLine(null), null);
    assert.equal(wowLine(undefined), null);
  });
});

describe('paceLine — ROI strip monthly run-rate pace', () => {
  it('renders "Monthly pace: {n}×" to one decimal', () => {
    assert.equal(paceLine({ paceMultiple: 21.2, subscriptionCost: 200 }), 'Monthly pace: 21.2×');
  });
  it('renders a negative multiple honestly (under-pace: spend below plan cost)', () => {
    assert.equal(paceLine({ paceMultiple: -1.5, subscriptionCost: 200 }), 'Monthly pace: -1.5×');
  });
  it('null roiPace (no trailing sessions / no valid cost) hides the line', () => {
    assert.equal(paceLine(null), null);
  });
});
