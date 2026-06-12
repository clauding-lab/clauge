// Integration tests for GET /api/projection + the usage-history ingest hook
// (on-device projection spec, Components 2 + 3). Spawns the real Hono server
// as a subprocess (server-additions style). The projection MATH is covered by
// test/projection.test.js — these tests assert only the wrapper plumbing:
// READ_ONLY_API_PATHS membership (ACAO reflection — the silent-CORS-denial
// failure mode), top-level response shape, and the ingest-side recorder.
//
// HOME is redirected to a tmp dir so ~/.clauge/{usage.json,usage-history.jsonl,
// config.json} and ~/.claude all resolve inside the sandbox. os.homedir()
// reads USERPROFILE (not HOME) on Windows, so these suites skip there — same
// pattern as the SIGTERM persistence suite in server-additions.test.js.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

const WINDOW_KEYS = [
  'fiveHour',
  'sevenDay',
  'sevenDaySonnet',
  'sevenDayOpus',
  'claudeDesign',
  'dailyRoutines',
];

const SKIP_WIN = process.platform === 'win32'
  ? 'HOME redirect ignored on Windows (os.homedir() uses USERPROFILE)'
  : false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(envOverrides = {}) {
  const child = spawn(SERVER_BIN, SERVER_ARGS, {
    env: { ...process.env, NO_OPEN: '1', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server start timeout')), 5000);
      const onData = (buf) => {
        if (buf.toString().includes('Listening on')) {
          child.stdout.off('data', onData);
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
    });
    return child;
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  }
}

// GET with an explicit Origin header (cors-allowlist.test.js pattern — node
// http.request, not fetch, so the Origin header is fully under our control).
// Resolves { status, acao, body } where body is parsed JSON or null.
function getWithOrigin(port, path, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(port), path, method: 'GET', headers: { Origin: origin } },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (b) => { buf += b; });
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(buf); } catch { /* non-JSON (e.g. 404 page) */ }
          resolve({
            status: res.statusCode,
            acao: res.headers['access-control-allow-origin'] ?? null,
            body,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/projection — nothing ingested', { skip: SKIP_WIN }, () => {
  let server, home;
  const PORT = '3530';

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-projection-`);
    server = await startServer({ PORT, HOME: home });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('reflects the loopback Origin (proves READ_ONLY_API_PATHS membership)', async () => {
    const origin = `http://127.0.0.1:${PORT}`;
    const r = await getWithOrigin(PORT, '/api/projection', origin);
    assert.equal(r.status, 200);
    assert.equal(r.acao, origin, 'loopback origin echoed as ACAO');
  });

  it('denies a foreign website origin (no ACAO echo)', async () => {
    const r = await getWithOrigin(PORT, '/api/projection', 'https://evil.example');
    assert.notEqual(r.acao, 'https://evil.example');
    assert.notEqual(r.acao, '*');
  });

  it('returns never-ingested freshness with every window suppressed', async () => {
    const r = await getWithOrigin(PORT, '/api/projection', `http://127.0.0.1:${PORT}`);
    assert.equal(r.status, 200);
    const body = r.body;
    assert.deepEqual(
      Object.keys(body).sort(),
      ['freshness', 'generatedAt', 'roiPace', 'windows'],
      'top-level keys are exactly {generatedAt, freshness, windows, roiPace}'
    );
    assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(body.freshness.ingested, false);
    assert.equal(body.freshness.ingestedAt, null);
    assert.equal(body.freshness.stale, true);
    for (const key of WINDOW_KEYS) {
      assert.ok(key in body.windows, `windows.${key} key present`);
      const w = body.windows[key];
      assert.ok(
        w === null || w.state === 'stale',
        `windows.${key} suppressed when never ingested, got ${JSON.stringify(w)}`
      );
    }
    // roiPace is NOT staleness-gated; it is null HERE because the sandboxed
    // HOME has zero sessions (apiEquivalentSpendTrailing === 0 -> null).
    assert.equal(body.roiPace, null);
  });
});

describe('POST /api/usage/ingest records a usage-history sample', { skip: SKIP_WIN }, () => {
  let server, home;
  const PORT = '3531';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-projection-ingest-`);
    server = await startServer({ PORT, HOME: home });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  const resetsFiveHour = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const resetsSevenDay = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

  it('creates a usage-history.jsonl line after a successful ingest', async () => {
    const res = await fetch(`${BASE}/api/usage/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usage: {
          five_hour: { utilization: 20, resets_at: resetsFiveHour },
          seven_day: { utilization: 50, resets_at: resetsSevenDay },
        },
      }),
    });
    assert.equal(res.status, 200);

    // The recorder is fire-and-forget — poll briefly for the line to land.
    const historyPath = `${home}/.clauge/usage-history.jsonl`;
    let raw = null;
    for (let i = 0; i < 20; i++) {
      try {
        raw = await readFile(historyPath, 'utf8');
        if (raw.trim()) break;
      } catch { /* not written yet */ }
      await sleep(100);
    }
    assert.ok(raw && raw.trim(), 'usage-history.jsonl written within 2s of ingest');

    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 1, 'exactly one sample line');
    const sample = JSON.parse(lines[0]);
    assert.equal(sample.v, 1);
    assert.match(sample.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    assert.equal(sample.w.fiveHour.pct, 20);
    assert.equal(sample.w.fiveHour.resetsAt, resetsFiveHour);
    assert.equal(sample.w.sevenDay.pct, 50);
    assert.equal(sample.w.sevenDay.resetsAt, resetsSevenDay);
    assert.ok(!('sevenDayOpus' in sample.w), 'null windows omitted from the line');
    assert.ok(!('extraUsage' in sample.w), 'non-window fields excluded from the allowlist');
  });

  it('GET /api/projection reflects the ingested record', async () => {
    const origin = `http://127.0.0.1:${PORT}`;
    const r = await getWithOrigin(PORT, '/api/projection', origin);
    assert.equal(r.status, 200);
    assert.equal(r.acao, origin);
    const body = r.body;
    assert.equal(body.freshness.ingested, true);
    assert.equal(body.freshness.stale, false, 'ingested seconds ago -> not stale');
    assert.match(body.freshness.ingestedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(body.windows.sevenDay.pct, 50, 'pct passthrough from the ingested record');
    assert.ok(
      ['will_hit', 'safe'].includes(body.windows.sevenDay.state),
      `forecastable state for a mid-window fresh sample, got ${body.windows.sevenDay.state}`
    );
    assert.equal(body.windows.claudeDesign, null, 'never-ingested bucket stays null (phantom-bucket lesson)');
    // Sandbox HOME has no ~/.claude sessions -> trailing spend 0 -> null.
    assert.equal(body.roiPace, null);
  });
});
