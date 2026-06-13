// Integration test for the C1.5 snapshot forecast enrichment (desktop publish).
// Spawns the real Hono server (server-projection.test.js harness) with HOME
// redirected to a tmp sandbox, seeds a fresh usage record + recent usage-history
// samples, then asserts:
//   1. NO-DRIFT: GET /api/snapshot's `forecast` (weekOverWeek + roiPace) is
//      identical to what GET /api/projection returns for the same window — the
//      snapshot re-publishes the projection verbatim, it never recomputes.
//   2. forecastHistory is the two hero windows only, every sample within 60 min
//      of generatedAt.
//   3. /api/snapshot still reflects a loopback Origin (READ_ONLY_API_PATHS guard).
//
// The projection MATH lives in test/projection.test.js; the forecastHistory
// slice + forecast passthrough are unit-tested in test/snapshot.test.js. This
// suite proves only the cross-endpoint identity (no-drift) + the wrapper wiring.
//
// HOME redirect is ignored on Windows (os.homedir() uses USERPROFILE) — skip
// there, same as server-projection.test.js.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

const SKIP_WIN = process.platform === 'win32'
  ? 'HOME redirect ignored on Windows (os.homedir() uses USERPROFILE)'
  : false;

const RECENT_SPAN_MS = 3600000; // 60 min (mirror of lib/projection.js)

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

// GET with explicit Origin (cors pattern — node http.request so Origin is ours).
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
          try { body = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] ?? null, body });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Seed a fresh usage record + a couple of recent history samples for the two
// hero windows, written directly to the sandbox ~/.clauge before the server
// starts (UsageStore/UsageHistory read these lazily on the first request).
async function seedSandbox(home) {
  const dir = join(home, '.clauge');
  await mkdir(dir, { recursive: true });

  const now = Date.now();
  const resetsFiveHour = new Date(now + 2 * 60 * 60 * 1000).toISOString();
  const resetsSevenDay = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();

  // Ingested seconds ago -> not stale -> windows are forecastable.
  const usageRecord = {
    ingestedAt: new Date(now).toISOString(),
    normalized: {
      fiveHour: { pct: 40, resetsAt: resetsFiveHour },
      sevenDay: { pct: 25, resetsAt: resetsSevenDay },
    },
  };
  await writeFile(join(dir, 'usage.json'), JSON.stringify(usageRecord, null, 2), { mode: 0o600 });

  // Two recent samples per hero window (oldest-first), all within RECENT_SPAN_MS
  // so forecastHistory is non-empty. The five-min spacing matches the recorder.
  const sampleAt = (ageMs) => new Date(now - ageMs).toISOString();
  const lines = [
    {
      v: 1,
      at: sampleAt(40 * 60 * 1000),
      w: {
        fiveHour: { pct: 20, resetsAt: resetsFiveHour },
        sevenDay: { pct: 18, resetsAt: resetsSevenDay },
      },
    },
    {
      v: 1,
      at: sampleAt(20 * 60 * 1000),
      w: {
        fiveHour: { pct: 30, resetsAt: resetsFiveHour },
        sevenDay: { pct: 22, resetsAt: resetsSevenDay },
      },
    },
  ];
  await writeFile(
    join(dir, 'usage-history.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    { mode: 0o600 },
  );
}

describe('GET /api/snapshot — C1.5 forecast enrichment', { skip: SKIP_WIN }, () => {
  let server, home;
  const PORT = '3532';
  const ORIGIN = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-snapshot-forecast-`);
    await seedSandbox(home);
    server = await startServer({ PORT, HOME: home });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('reflects the loopback Origin (READ_ONLY_API_PATHS membership intact)', async () => {
    const r = await getWithOrigin(PORT, '/api/snapshot', ORIGIN);
    assert.equal(r.status, 200);
    assert.equal(r.acao, ORIGIN, 'loopback origin echoed as ACAO');
  });

  it('NO-DRIFT: snapshot.forecast equals /api/projection roiPace + sevenDay weekOverWeek', async () => {
    // Two separate requests, ms apart. roiPace is computed from 7-day spend and
    // weekOverWeek from sample geometry — both stable across a few ms, so the
    // deep-equal identity is the contract (null === null when unpaired/no-data).
    const proj = (await getWithOrigin(PORT, '/api/projection', ORIGIN)).body;
    const snap = (await getWithOrigin(PORT, '/api/snapshot', ORIGIN)).body;

    assert.ok(snap.forecast, 'forecast block present');
    assert.deepEqual(
      snap.forecast.roiPace,
      proj.roiPace,
      'snapshot.forecast.roiPace must equal /api/projection roiPace (no drift)',
    );
    assert.deepEqual(
      snap.forecast.weekOverWeek,
      proj.windows.sevenDay.weekOverWeek,
      'snapshot.forecast.weekOverWeek must equal projection.windows.sevenDay.weekOverWeek (no drift)',
    );
  });

  it('forecastHistory carries ONLY the two hero windows, every sample within 60 min of generatedAt', async () => {
    const snap = (await getWithOrigin(PORT, '/api/snapshot', ORIGIN)).body;
    assert.deepEqual(Object.keys(snap.forecastHistory).sort(), ['fiveHour', 'sevenDay']);

    const genMs = Date.parse(snap.generatedAt);
    for (const key of ['fiveHour', 'sevenDay']) {
      assert.ok(snap.forecastHistory[key].length > 0, `${key} has recent samples`);
      for (const sample of snap.forecastHistory[key]) {
        assert.deepEqual(Object.keys(sample).sort(), ['at', 'pct', 'resetsAt']);
        const ageMs = genMs - Date.parse(sample.at);
        assert.ok(ageMs <= RECENT_SPAN_MS, `${key} sample within 60 min of generatedAt`);
      }
    }
    // pct passes through unchanged (engine units 0-100), oldest-first.
    assert.deepEqual(snap.forecastHistory.fiveHour.map((s) => s.pct), [20, 30]);
  });

  it('keeps schemaVersion at 1 while both new forecast blocks coexist (landmine #37)', async () => {
    const snap = (await getWithOrigin(PORT, '/api/snapshot', ORIGIN)).body;
    assert.equal(snap.schemaVersion, 1, 'no schema bump — both blocks are OPTIONAL keys');
    assert.ok('forecast' in snap && 'forecastHistory' in snap);
  });
});
