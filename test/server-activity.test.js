// Integration tests for GET /api/activity (v0.9.4 Phase A.2). Spawns the
// real Hono server as a subprocess; verifies shape, period handling, and
// invalid-input behavior. The pure aggregation logic is covered by
// test/cli/activity.test.js — these tests only assert the wrapper plumbing.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

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

describe('GET /api/activity', () => {
  let server;
  const PORT = '3510';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => { server = await startServer({ PORT }); });
  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
  });

  it('returns valid shape for default period (365d)', async () => {
    const res = await fetch(`${BASE}/api/activity`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period, '365d');
    assert.equal(body.totalDays, 365);
    assert.equal(typeof body.tz, 'string');
    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(body.rangeStart, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof body.activeDays, 'number');
    assert.equal(typeof body.currentStreak, 'number');
    assert.equal(typeof body.longestStreak, 'number');
    assert.ok(Array.isArray(body.days));
    assert.equal(body.days.length, 365);
    // Every day must have the documented shape
    for (const d of body.days) {
      assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(typeof d.sessions, 'number');
      assert.equal(typeof d.tokens, 'number');
      assert.equal(typeof d.costUSD, 'number');
      assert.equal(typeof d.claudeAiMessages, 'number');
      assert.equal(typeof d.intensity, 'number');
      assert.ok(d.intensity >= 0 && d.intensity <= 4);
    }
  });

  it('supports period=120d', async () => {
    const res = await fetch(`${BASE}/api/activity?period=120d`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period, '120d');
    assert.equal(body.totalDays, 120);
    assert.equal(body.days.length, 120);
  });

  it('supports period=180d', async () => {
    const res = await fetch(`${BASE}/api/activity?period=180d`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period, '180d');
    assert.equal(body.totalDays, 180);
    assert.equal(body.days.length, 180);
  });

  it('supports period=all', async () => {
    const res = await fetch(`${BASE}/api/activity?period=all`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.period, 'all');
    assert.ok(body.totalDays >= 1, 'all-time has at least one day (today)');
    assert.equal(body.days.length, body.totalDays);
  });

  it('rejects invalid period with HTTP 400', async () => {
    const res = await fetch(`${BASE}/api/activity?period=bogus`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /unsupported period/i);
  });

  it('respects ?tz override', async () => {
    const res = await fetch(`${BASE}/api/activity?period=180d&tz=Asia/Dhaka`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tz, 'Asia/Dhaka');
  });

  it('responds to OPTIONS without wildcard CORS (read-only endpoint, loopback-restricted)', async () => {
    const res = await fetch(`${BASE}/api/activity`, { method: 'OPTIONS' });
    assert.ok(res.status === 204 || res.status === 200, `OPTIONS got ${res.status}`);
    // CORS is now restricted to the app's own loopback origins (S2). A request
    // with no Origin header (as fetch sends here) receives no ACAO at all.
    const acao = res.headers.get('access-control-allow-origin');
    assert.notEqual(acao, '*', 'wildcard CORS removed');
    assert.equal(acao, null, 'no Origin header -> no ACAO');
  });
});
