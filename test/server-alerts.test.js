// Integration tests for GET /api/alerts/pending + POST /api/alerts/ack
// (active-guardrail sub-project B). Spawns the real Hono server (server-
// additions style). The engine MATH is covered by test/alert-engine.test.js;
// these assert only the endpoint plumbing: {due, retire} shape, side-effect-
// freedom of the GET (a Rust crash before ack must re-fire next tick), ack
// marks fired (a subsequent GET omits them), and malformed-body 400s.
//
// /api/alerts/pending is deliberately NOT in READ_ONLY_API_PATHS — it is a
// loopback-only Rust request with no Origin header, so it never needs the CORS
// echo and the webview never reads it. Sandbox ~/.clauge via CLAUGE_HOME.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

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

// Ingest a seven_day window at 100% with a FUTURE reset, so limitReached is
// eligible (pct>=100 AND resetsAt>nowMs) regardless of the stale gate. The
// just-ingested record is fresh, so willHit/approaching are not suppressed —
// but limitReached (rank 4) is the highest-severity alert, so it is the sole
// `due` and the lower approaching keys are retired.
async function ingestSevenDayAt100(base) {
  const resetsSevenDay = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${base}/api/usage/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usage: { seven_day: { utilization: 100, resets_at: resetsSevenDay } },
    }),
  });
  assert.equal(res.status, 200, 'ingest seeds the over-limit window');
}

describe('GET /api/alerts/pending — shape + side-effect-free', () => {
  let server, home;
  const PORT = '3540';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-alerts-pending-`);
    server = await startServer({ PORT, CLAUGE_HOME: home, HOME: home });
    await ingestSevenDayAt100(BASE);
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('returns a {due, retire} object of the right shape', async () => {
    const res = await fetch(`${BASE}/api/alerts/pending`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['due', 'retire'], 'exactly {due, retire}');
    assert.ok(Array.isArray(body.due), 'due is an array');
    assert.ok(Array.isArray(body.retire), 'retire is an array');
    assert.ok(body.due.length >= 1, 'a 100% window yields at least one due alert');
    const a = body.due[0];
    for (const k of ['id', 'type', 'window', 'title', 'body']) {
      assert.ok(k in a, `due alert carries ${k}`);
    }
    assert.equal(a.type, 'limitReached', 'pct=100 -> limitReached is the highest-severity due alert');
    assert.equal(a.window, 'sevenDay');
  });

  it('is side-effect-free: a second GET returns the SAME due set (no firing on read)', async () => {
    const a = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    const b = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    assert.deepEqual(
      a.due.map((x) => x.id).sort(),
      b.due.map((x) => x.id).sort(),
      'two reads without an ack return identical due ids'
    );
  });
});

describe('POST /api/alerts/ack — marks fired + idempotent + validation', () => {
  let server, home;
  const PORT = '3541';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-alerts-ack-`);
    server = await startServer({ PORT, CLAUGE_HOME: home, HOME: home });
    await ingestSevenDayAt100(BASE);
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('after acking the due ids, a fresh GET no longer returns them', async () => {
    const pending = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    const firedIds = pending.due.map((x) => x.id);
    assert.ok(firedIds.length >= 1, 'precondition: at least one due alert');

    const ackRes = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: firedIds, retired: pending.retire }),
    });
    assert.equal(ackRes.status, 200);

    const after = await (await fetch(`${BASE}/api/alerts/pending`)).json();
    const stillDue = after.due.map((x) => x.id);
    for (const id of firedIds) {
      assert.ok(!stillDue.includes(id), `acked id ${id} is no longer due`);
    }
  });

  it('is idempotent: re-acking the same ids 200s and changes nothing', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: ['limitReached:sevenDay:2099-01-01T00:00:00+00:00'], retired: [] }),
    });
    assert.equal(res.status, 200);
    const again = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: ['limitReached:sevenDay:2099-01-01T00:00:00+00:00'], retired: [] }),
    });
    assert.equal(again.status, 200);
  });

  it('rejects a non-array fired with 400', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: 'not-an-array', retired: [] }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects a non-array retired with 400', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: [], retired: 42 }),
    });
    assert.equal(res.status, 400);
  });

  it('rejects non-JSON with 400', async () => {
    const res = await fetch(`${BASE}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'garbage',
    });
    assert.equal(res.status, 400);
  });
});
