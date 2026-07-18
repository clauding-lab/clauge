// Tests for lib/cli/status-render.js — the PURE Clauge Widget renderer.
// Named after the §4 LOCKED render contract (spec: docs/superpowers/specs/
// 2026-07-16-cli-statusline-widget-design.md rev 4, owner-locked 2026-07-18),
// not after functions. No I/O, no clock reads — everything injected.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatus, truncateAnsi } from '../../lib/cli/status-render.js';

const NOW = Date.parse('2026-07-18T12:00:00Z');
const HOME = '/Users/adnan';

// Verified statusLine stdin payload shape (code.claude.com/docs/en/statusline,
// re-verified 2026-07-18): model.display_name, workspace.current_dir,
// cost.total_lines_added/removed, cost.total_duration_ms,
// context_window.used_percentage (nullable early in a session).
function payload(overrides = {}) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: `${HOME}/Projects/clauge`,
    model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
    workspace: {
      current_dir: `${HOME}/Projects/clauge`,
      project_dir: `${HOME}/Projects/clauge`,
    },
    version: '2.1.90',
    cost: {
      total_cost_usd: 1.23,
      total_duration_ms: 42 * 60_000,
      total_api_duration_ms: 90_000,
      total_lines_added: 267,
      total_lines_removed: 0,
    },
    context_window: {
      context_window_size: 200_000,
      used_percentage: 46,
      remaining_percentage: 54,
    },
    ...overrides,
  };
}

// A /v1/usage claude snapshot (frozen wire shape, PR #67 + the PR-C additive
// ROI (30d) line). resets_at values sit 2h24m and 5d past NOW.
function snapshot(overrides = {}) {
  return {
    apiVersion: 1,
    providerId: 'claude',
    displayName: 'Claude',
    plan: null,
    fetchedAt: new Date(NOW - 60_000).toISOString(),
    lines: [
      {
        type: 'progress',
        label: 'Session',
        used: 20,
        limit: 100,
        format: { kind: 'percent' },
        resets_at: new Date(NOW + (2 * 60 + 24) * 60_000).toISOString(),
      },
      {
        type: 'progress',
        label: 'Weekly',
        used: 9,
        limit: 100,
        format: { kind: 'percent' },
        resets_at: new Date(NOW + 5 * 24 * 3600_000).toISOString(),
      },
      { type: 'text', label: 'Spend', value: '$664 this window' },
      { type: 'text', label: 'ROI', value: '2.3x vs API' },
      { type: 'text', label: 'ROI (30d)', value: '17.3x vs API' },
    ],
    ...overrides,
  };
}

function render(inputs = {}, opts = {}) {
  return renderStatus(
    {
      payload: payload(),
      snapshot: snapshot(),
      branch: 'main',
      compactions: 0,
      cacheAgeMs: null,
      nowMs: NOW,
      homeDir: HOME,
      ...inputs,
    },
    { ansi: false, ...opts },
  );
}

const ESC = '\x1b[';
const ORANGE = '\x1b[38;5;208m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BLUE = '\x1b[34m';

describe('locked three-line render (colors stripped)', () => {
  test('renders the §4 golden output exactly', () => {
    assert.equal(
      render(),
      [
        'Opus 4.8 · ~/Projects/clauge · +267/-0 · ⧗ 42m · main',
        'Session ▓▓░░░░░░░░ 20% (resets 2h) · Weekly ▓░░░░░░░░░ 9% (resets 5d)',
        '$664 this window · ROI 17.3× vs API · Context Used 46% · Compactions 0',
      ].join('\n'),
    );
  });

  test('ROI segment prefers the ROI (30d) line over the frozen 7d ROI line', () => {
    assert.match(render(), /ROI 17\.3× vs API/);
    assert.ok(!render().includes('2.3×'));
  });

  test('ROI segment falls back to the 7d ROI line when no ROI (30d) exists', () => {
    const snap = snapshot();
    snap.lines = snap.lines.filter((l) => l.label !== 'ROI (30d)');
    assert.match(render({ snapshot: snap }), /ROI 2\.3× vs API/);
  });

  test('runtime over an hour renders as Xh Ym', () => {
    const p = payload();
    p.cost.total_duration_ms = 90 * 60_000;
    assert.match(render({ payload: p }), /⧗ 1h 30m/);
  });

  test('resets under an hour renders in minutes', () => {
    const snap = snapshot();
    snap.lines[0].resets_at = new Date(NOW + 45 * 60_000).toISOString();
    assert.match(render({ snapshot: snap }), /Session ▓▓░░░░░░░░ 20% \(resets 45m\)/);
  });

  test('working path outside the home dir is shown unabbreviated', () => {
    const p = payload();
    p.workspace.current_dir = '/opt/work';
    assert.match(render({ payload: p }), /· \/opt\/work ·/);
  });
});

describe('gauge bars', () => {
  const barOf = (pct) => {
    const snap = snapshot();
    snap.lines[0].used = pct;
    const line2 = render({ snapshot: snap }).split('\n')[1];
    return line2.match(/Session ([▓░]{10})/)[1];
  };

  test('fill count is pct/10 rounded (0, 9, 75, 93, 100)', () => {
    assert.equal(barOf(0), '░░░░░░░░░░');
    assert.equal(barOf(9), '▓░░░░░░░░░');
    assert.equal(barOf(75), '▓▓▓▓▓▓▓▓░░');
    assert.equal(barOf(93), '▓▓▓▓▓▓▓▓▓░');
    assert.equal(barOf(100), '▓▓▓▓▓▓▓▓▓▓');
  });
});

describe('threshold color grammar (ANSI on)', () => {
  test('gauges color independently: Session 78% orange while Weekly 31% green', () => {
    const snap = snapshot();
    snap.lines[0].used = 78;
    snap.lines[1].used = 31;
    const out = render({ snapshot: snap }, { ansi: true, orange256: true });
    const line2 = out.split('\n')[1];
    assert.ok(line2.includes(`${ORANGE}▓▓▓▓▓▓▓▓░░`), 'Session bar is 256-color orange');
    assert.ok(line2.includes(`${GREEN}▓▓▓░░░░░░░`), 'Weekly bar stays green');
  });

  test('90%+ goes red', () => {
    const snap = snapshot();
    snap.lines[0].used = 93;
    const out = render({ snapshot: snap }, { ansi: true, orange256: true });
    assert.ok(out.includes(`${RED}▓▓▓▓▓▓▓▓▓░`));
  });

  test('orange falls back to plain yellow on 8/16-color terminals', () => {
    const snap = snapshot();
    snap.lines[0].used = 78;
    const out = render({ snapshot: snap }, { ansi: true, orange256: false });
    assert.ok(out.includes(`${YELLOW}▓▓▓▓▓▓▓▓░░`));
    assert.ok(!out.includes(ORANGE));
  });

  test('Context Used obeys the same 75/90 scale', () => {
    const p = payload();
    p.context_window.used_percentage = 95;
    const out = render({ payload: p }, { ansi: true, orange256: true });
    assert.ok(out.includes(`${RED}95%`));
  });

  test('Compactions has its own scale: 0 green, 1 orange, 2+ red', () => {
    const at = (n, opts) => render({ compactions: n }, { ansi: true, orange256: true, ...opts });
    assert.ok(at(0).includes(`${GREEN}0`));
    assert.ok(at(1).includes(`${ORANGE}1`));
    assert.ok(at(2).includes(`${RED}2`));
    assert.ok(at(5).includes(`${RED}5`));
  });

  test('yellow is reserved for money: $ and ROI yellow, never orange', () => {
    const out = render({}, { ansi: true, orange256: true });
    const line3 = out.split('\n')[2];
    assert.ok(line3.includes(`${YELLOW}$664`));
    assert.ok(line3.includes(`${YELLOW}17.3×`));
    assert.ok(!line3.includes(ORANGE));
  });

  test('ansi:false emits zero escape sequences', () => {
    const snap = snapshot();
    snap.lines[0].used = 93;
    assert.ok(!render({ snapshot: snap }).includes(ESC));
  });
});

describe('segment omission — parse defensively, never crash', () => {
  test('null payload drops line 1 and the stdin-sourced line-3 segments', () => {
    const out = render({ payload: null, branch: null, compactions: null });
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Session /);
    assert.equal(lines[1], '$664 this window · ROI 17.3× vs API');
  });

  test('missing model drops only the model segment', () => {
    const p = payload();
    delete p.model;
    const line1 = render({ payload: p }).split('\n')[0];
    assert.equal(line1, '~/Projects/clauge · +267/-0 · ⧗ 42m · main');
  });

  test('null context_window.used_percentage drops the Context Used segment', () => {
    const p = payload();
    p.context_window.used_percentage = null;
    assert.ok(!render({ payload: p }).includes('Context Used'));
  });

  test('missing cost drops churn and runtime but keeps model/path/branch', () => {
    const p = payload();
    delete p.cost;
    const line1 = render({ payload: p }).split('\n')[0];
    assert.equal(line1, 'Opus 4.8 · ~/Projects/clauge · main');
  });

  test('null branch drops the branch segment', () => {
    const line1 = render({ branch: null }).split('\n')[0];
    assert.equal(line1, 'Opus 4.8 · ~/Projects/clauge · +267/-0 · ⧗ 42m');
  });

  test('null compactions drops the Compactions segment', () => {
    assert.ok(!render({ compactions: null }).includes('Compactions'));
  });

  test('snapshot without Session/Weekly still renders spend + ROI', () => {
    const snap = snapshot();
    snap.lines = snap.lines.filter((l) => l.type !== 'progress');
    const out = render({ snapshot: snap });
    assert.ok(!out.includes('Session'));
    assert.match(out, /\$664 this window · ROI 17\.3× vs API/);
  });
});

describe('degraded states', () => {
  test('cache-served render appends the age tag', () => {
    const out = render({ cacheAgeMs: 12 * 60_000 });
    assert.ok(out.endsWith('· 12m old'));
  });

  test('no snapshot + no payload renders only the app-not-running notice', () => {
    const out = render({ payload: null, snapshot: null, branch: null, compactions: null });
    assert.equal(out, 'clauge: app not running');
  });

  test('no snapshot still renders the stdin-sourced line 1, then the notice', () => {
    const out = render({ snapshot: null, compactions: 1 });
    const lines = out.split('\n');
    assert.equal(lines[0], 'Opus 4.8 · ~/Projects/clauge · +267/-0 · ⧗ 42m · main');
    assert.equal(lines[1], 'clauge: app not running');
  });
});

describe('terminal-escape injection — externally-sourced text is sanitized', () => {
  // Security review 2026-07-18 (P1): model.display_name, the working dir,
  // and cache/v1 text values are attacker-influenceable (hostile repo dir
  // names may contain ESC on Unix; the cache is a same-user file). OSC52
  // clipboard writes, title-set, clear-screen, and forged newlines must
  // never reach the host terminal.
  test('a hostile directory name cannot smuggle OSC/CSI sequences or forge lines', () => {
    const p = payload();
    p.workspace.current_dir = '/tmp/evil\x1b]52;c;cGxhbnQ=\x07dir\nFORGED LINE';
    const out = render({ payload: p }, { ansi: true, orange256: true });
    assert.ok(!out.includes('\x1b]'), 'no OSC sequence survives');
    assert.ok(!out.includes('\x07'), 'no BEL survives');
    assert.equal(out.split('\n').length, 3, 'no forged extra line');
  });

  test('a hostile model display_name cannot clear the screen', () => {
    const p = payload();
    p.model.display_name = 'Opus\x1b[2J 4.8';
    const out = render({ payload: p }, { ansi: true, orange256: true });
    assert.ok(!out.includes('\x1b[2J'), 'the ESC byte must be stripped');
    // Stripping the ESC defangs the sequence; the remainder is inert text.
    assert.match(out, /Opus\[2J 4\.8/);
  });

  test('a poisoned cache Spend/ROI value cannot set the terminal title', () => {
    const snap = snapshot();
    snap.lines = snap.lines.map((l) =>
      l.type === 'text' ? { ...l, value: `${l.value}\x1b]0;pwned\x07` } : l,
    );
    const out = render({ snapshot: snap }, { ansi: true, orange256: true });
    assert.ok(!out.includes('\x1b]0;'));
    assert.ok(!out.includes('pwned\x07'));
  });

  test('plain mode emits ZERO escape bytes even under hostile inputs', () => {
    const p = payload();
    p.model.display_name = 'X\x1b[31m';
    p.workspace.current_dir = '/a\x1b]0;t\x07b';
    const snap = snapshot();
    snap.lines[3] = { type: 'text', label: 'ROI', value: '2.3x vs\x1b[5m API' };
    const out = render({ payload: p, snapshot: snap, branch: 'b\x1b[0mr' });
    assert.ok(!out.includes('\x1b'), `escape byte leaked: ${JSON.stringify(out)}`);
  });
});

describe('scoped-limit gauges — rev 5 (2026-07-19 owner request)', () => {
  // /v1 progress lines shaped `Weekly (<label>)` / `Session (<label>)` (e.g.
  // Fable) render as additional line-2 gauges, after the two hero gauges,
  // same bar/percent/resets format, capped at SCOPED_GAUGES_MAX = 2.

  test('a scoped progress line renders as a third gauge after Weekly', () => {
    const snap = snapshot();
    snap.lines.splice(2, 0, {
      type: 'progress',
      label: 'Weekly (Fable)',
      used: 68,
      limit: 100,
      format: { kind: 'percent' },
      resets_at: new Date(NOW + 4 * 24 * 3600_000).toISOString(),
    });
    const line2 = render({ snapshot: snap }).split('\n')[1];
    assert.equal(
      line2,
      'Session ▓▓░░░░░░░░ 20% (resets 2h) · Weekly ▓░░░░░░░░░ 9% (resets 5d) · Fable ▓▓▓▓▓▓▓░░░ 68% (resets 4d)',
    );
  });

  test('no scoped lines leaves line 2 byte-identical to the hero-only golden (regression pin)', () => {
    const line2 = render().split('\n')[1];
    assert.equal(
      line2,
      'Session ▓▓░░░░░░░░ 20% (resets 2h) · Weekly ▓░░░░░░░░░ 9% (resets 5d)',
    );
  });

  test('caps scoped gauges at 2, wire order wins', () => {
    const snap = snapshot();
    snap.lines.splice(
      2,
      0,
      { type: 'progress', label: 'Weekly (Fable)', used: 10, resets_at: null },
      { type: 'progress', label: 'Session (Sonnet)', used: 20, resets_at: null },
      { type: 'progress', label: 'Weekly (Opus)', used: 30, resets_at: null },
    );
    const line2 = render({ snapshot: snap }).split('\n')[1];
    assert.ok(line2.includes('Fable'), 'first scoped line renders');
    assert.ok(line2.includes('Sonnet'), 'second scoped line renders');
    assert.ok(!line2.includes('Opus'), 'third scoped line is dropped by the cap');
  });

  test('a hostile scoped label cannot smuggle an ANSI escape into line 2', () => {
    const snap = snapshot();
    snap.lines.push({
      type: 'progress',
      label: 'Weekly (Fa\x1b[31mble)',
      used: 50,
      resets_at: null,
    });
    const out = render({ snapshot: snap }, { ansi: true, orange256: true });
    assert.ok(!out.includes('\x1b[31mble'), 'no raw ESC byte survives in the rendered line');
    assert.match(out.split('\n')[1], /Fa\[31mble/);
  });

  test('a Session (X) shaped label renders a gauge labeled X — prefix does not matter', () => {
    const snap = snapshot();
    snap.lines.push({ type: 'progress', label: 'Session (Haiku)', used: 15, resets_at: null });
    const line2 = render({ snapshot: snap }).split('\n')[1];
    assert.match(line2, /Haiku ▓▓░░░░░░░░ 15%/);
  });

  test('a scoped line without resets_at omits the resets suffix on that gauge', () => {
    const snap = snapshot();
    snap.lines.push({ type: 'progress', label: 'Weekly (Fable)', used: 40 });
    const line2 = render({ snapshot: snap }).split('\n')[1];
    assert.ok(line2.endsWith('Fable ▓▓▓▓░░░░░░ 40%'), 'no (resets …) suffix follows');
  });

  test('scoped gauges render blue always (owner decision), never the warning thresholds', () => {
    // Rev 5.1: scoped gauges ignore the 75/90 threshold ladder entirely —
    // blue at 80% (would be orange for a hero gauge) AND blue at 95%
    // (would be red for a hero gauge).
    // Assert against line 2 only — line 1's `-0` lines-removed segment is
    // unconditionally red (git-churn color, unrelated to gauge thresholds),
    // so checking the whole render would false-positive on "never red".
    const snap80 = snapshot();
    snap80.lines.push({ type: 'progress', label: 'Weekly (Fable)', used: 80, resets_at: null });
    const line2At80 = render({ snapshot: snap80 }, { ansi: true, orange256: true }).split('\n')[1];
    assert.ok(line2At80.includes(`${BLUE}▓▓▓▓▓▓▓▓░░`), 'scoped bar at 80% is blue');
    assert.ok(line2At80.includes(`${BLUE}80%`), 'scoped pct at 80% is blue');
    assert.ok(!line2At80.includes(ORANGE), 'scoped gauge never emits orange');
    assert.ok(!line2At80.includes(RED), 'scoped gauge never emits red');

    const snap95 = snapshot();
    snap95.lines.push({ type: 'progress', label: 'Weekly (Fable)', used: 95, resets_at: null });
    const line2At95 = render({ snapshot: snap95 }, { ansi: true, orange256: true }).split('\n')[1];
    assert.ok(line2At95.includes(`${BLUE}▓▓▓▓▓▓▓▓▓▓`), 'scoped bar at 95% is blue');
    assert.ok(line2At95.includes(`${BLUE}95%`), 'scoped pct at 95% is blue');
    assert.ok(!line2At95.includes(ORANGE), 'scoped gauge never emits orange');
    assert.ok(!line2At95.includes(RED), 'scoped gauge never emits red');
  });

  test('a text-type line shaped like a scoped label is not rendered as a gauge', () => {
    const snap = snapshot();
    snap.lines.push({ type: 'text', label: 'Weekly (Fake)', value: 'nope' });
    const line2 = render({ snapshot: snap }).split('\n')[1];
    assert.ok(!line2.includes('Fake'));
  });
});

describe('--max-width', () => {
  test('caps each line at N visible characters', () => {
    const out = render({}, { maxWidth: 40 });
    for (const line of out.split('\n')) {
      assert.ok([...line].length <= 40, `${line} exceeds 40 chars`);
    }
  });

  test('truncateAnsi counts visible chars, not escape bytes, and re-arms reset', () => {
    const colored = `${GREEN}▓▓▓▓▓${'\x1b[0m'} rest of the line`;
    const cut = truncateAnsi(colored, 5);
    assert.ok(cut.startsWith(`${GREEN}▓▓▓▓▓`));
    assert.ok(cut.endsWith('\x1b[0m'));
    const visible = cut.replace(/\x1b\[[0-9;]*m/g, '');
    assert.equal([...visible].length, 5);
  });
});
