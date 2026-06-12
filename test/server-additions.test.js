import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

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

describe('GET /api/health', () => {
  let server;
  before(async () => { server = await startServer({ PORT: '3499' }); });
  after(() => {
    if (server && !server.killed) server.kill('SIGTERM');
  });

  it('returns 200 with service identity', async () => {
    const res = await fetch('http://127.0.0.1:3499/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, 'clauge', 'service identifier matches');
    assert.ok(typeof body.version === 'string', 'version is a string');
    assert.ok(typeof body.pid === 'number', 'pid is a number');
  });
});

describe('port fallback', () => {
  let blocker, server;

  before(async () => {
    // Hold port 3500 with a dummy listener so server has to fall back.
    // Bind explicitly to 127.0.0.1 to match the production server's bind
    // (server.js passes `hostname: '127.0.0.1'` to serve()). Without the
    // explicit host, Node defaults to `::` (IPv6 wildcard), and on macOS a
    // `::` blocker does NOT conflict with a `127.0.0.1` bind on the same
    // port — the server would happily grab 3500 and the test would fetch
    // 3501 from a different process (or 404).
    blocker = createServer().listen(3500, '127.0.0.1');
    await new Promise((resolve, reject) => {
      blocker.once('listening', resolve);
      blocker.once('error', reject);
    });
    server = await startServer({ PORT: '3500' });
  });

  after(async () => {
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    if (blocker) {
      await new Promise((r) => blocker.close(r));
    }
  });

  it('falls back to next port when configured port is busy', async () => {
    // Server should have logged "Listening on" with port 3501.
    // Tie the response to THIS spawned child via pid to rule out a stale
    // process accidentally satisfying the assertion.
    const res = await fetch('http://127.0.0.1:3501/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pid, server.pid);
  });

  it('exposes chosen port via stderr line for Tauri to parse', async () => {
    const child = spawn(SERVER_BIN, SERVER_ARGS, {
      env: { ...process.env, PORT: '3502', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('marker timeout')), 5000);
        child.stderr.on('data', (b) => {
          stderrBuf += b.toString();
          if (/CLAUGE_BOUND_PORT=\d+/.test(stderrBuf)) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      assert.match(stderrBuf, /CLAUGE_BOUND_PORT=3502/);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  });
});

// Windows note: Node's child.kill('SIGTERM') is emulated as a hard kill on
// Windows (no POSIX signals; signal arg is ignored per Node docs), so the
// server's SIGTERM handler never runs and the exit-code assertion fails.
// Additionally, os.homedir() uses USERPROFILE (not HOME) on Windows, so the
// test's `env: { HOME: claudeDir }` redirect is silently ignored. The Tauri
// shell on Windows handles sidecar lifecycle via its own process-kill path
// (lib.rs::RunEvent::ExitRequested → CommandChild::kill), not SIGTERM.
describe('SIGTERM graceful shutdown', {
  skip: process.platform === 'win32'
    ? 'SIGTERM emulated as hard kill on Windows; Tauri shell uses CommandChild::kill instead'
    : false,
}, () => {
  it('exits with code 0 within 2s of SIGTERM', async () => {
    const child = spawn(SERVER_BIN, SERVER_ARGS, {
      env: { ...process.env, PORT: '3503', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((r) => {
      const onD = (b) => b.toString().includes('Listening on') && (child.stdout.off('data', onD), r());
      child.stdout.on('data', onD);
    });

    const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const startMs = Date.now();
    child.kill('SIGTERM');
    const code = await Promise.race([
      exitPromise,
      sleep(2500).then(() => 'TIMEOUT'),
    ]);

    if (code === 'TIMEOUT') child.kill('SIGKILL');
    assert.notEqual(code, 'TIMEOUT', 'server exited within 2.5s');
    assert.equal(code, 0, 'clean exit code');
    assert.ok(Date.now() - startMs < 2500, 'shutdown was prompt');
  });

  it('persists completed /api/usage/ingest across SIGTERM', async () => {
    // The /api/usage/ingest route awaits usageStore.save() before responding,
    // so a 200 means the write already landed on disk. This test verifies the
    // shutdown path doesn't corrupt or truncate that completed write — which
    // is the actual contract spec §6.7 promises (response handlers awaiting
    // writes have returned before close()).
    const claugeDir = await mkdtemp(`${tmpdir()}/clauge-test-`);
    try {
      const child = spawn(SERVER_BIN, SERVER_ARGS, {
        env: { ...process.env, PORT: '3504', NO_OPEN: '1', HOME: claugeDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      await new Promise((r) => {
        const onD = (b) => b.toString().includes('Listening on') && (child.stdout.off('data', onD), r());
        child.stdout.on('data', onD);
      });

      // The ingest route requires { usage: ... }; balance is optional and lands
      // in normalized.balance after normalizeBalance() runs.
      const ingestRes = await fetch('http://127.0.0.1:3504/api/usage/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usage: { seven_day: { utilization: 0.5 } },
          balance: { amount: 1000, currency: 'USD' },
        }),
      });
      assert.equal(ingestRes.status, 200);

      child.kill('SIGTERM');
      // Bound the wait so a regression in the shutdown handler can't hang the
      // suite indefinitely. Mirrors the timeout pattern in the prior test.
      const exited = await Promise.race([
        new Promise((r) => child.on('exit', () => r('exit'))),
        sleep(2500).then(() => 'TIMEOUT'),
      ]);
      if (exited === 'TIMEOUT') {
        child.kill('SIGKILL');
        await new Promise((r) => child.on('exit', r));
        throw new Error('child did not exit within 2.5s of SIGTERM');
      }

      const persisted = JSON.parse(
        await readFile(`${claugeDir}/.clauge/usage.json`, 'utf8')
      );
      // Tie the persisted record back to what was actually sent so a future
      // regression that writes a default-shaped record (instead of the real
      // payload) would be caught.
      assert.ok(persisted.normalized, 'normalized snapshot persisted');
      assert.ok(persisted.normalized.balance, 'balance was persisted');
      assert.equal(persisted.normalized.balance.currency, 'USD');
      assert.equal(persisted.rawBalance.amount, 1000);
    } finally {
      await rm(claugeDir, { recursive: true, force: true });
    }
  });
});

// Component 4 of the on-device projection spec: the subscription cost is a
// persisted sidecar-owned setting (~/.clauge/config.json) with precedence
// file -> SUBSCRIPTION_COST env -> 200, editable at runtime via
// POST /api/config/subscription-cost (no sidecar restart needed).
// HOME-redirect caveat: os.homedir() reads USERPROFILE (not HOME) on
// Windows, so the sandbox redirect is silently ignored there — skip, same
// rationale as the SIGTERM suite above.
describe('subscription-cost setting (POST /api/config/subscription-cost)', {
  skip: process.platform === 'win32'
    ? 'HOME redirect ignored on Windows (os.homedir() uses USERPROFILE)'
    : false,
}, () => {
  let server, home;
  const PORT = '3505';
  const BASE = `http://127.0.0.1:${PORT}`;

  before(async () => {
    home = await mkdtemp(`${tmpdir()}/clauge-config-`);
    // Pin the env tier explicitly so an ambient SUBSCRIPTION_COST (.env or
    // shell) can't make the precedence assertions flaky.
    server = await startServer({ PORT, HOME: home, SUBSCRIPTION_COST: '175' });
  });

  after(async () => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    await rm(home, { recursive: true, force: true });
  });

  it('serves the env-tier cost when nothing is persisted', async () => {
    const res = await fetch(`${BASE}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscriptionCost, 175);
  });

  it('rejects invalid bodies with 400 and leaves the effective cost unchanged', async () => {
    const badBodies = [
      'not json at all',
      '{}',
      '{"subscriptionCost":0}',
      '{"subscriptionCost":-5}',
      '{"subscriptionCost":"150"}',
      '{"subscriptionCost":null}',
    ];
    for (const body of badBodies) {
      const res = await fetch(`${BASE}/api/config/subscription-cost`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      assert.equal(res.status, 400, `expected 400 for body: ${body}`);
    }
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert.equal(cfg.subscriptionCost, 175, 'effective cost untouched by rejected posts');
  });

  it('persists a valid cost and every consumer reflects it without a restart', async () => {
    const res = await fetch(`${BASE}/api/config/subscription-cost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionCost: 120 }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { subscriptionCost: 120 });

    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    assert.equal(cfg.subscriptionCost, 120, '/api/config reflects the persisted value');

    const health = await (await fetch(`${BASE}/api/health`)).json();
    assert.equal(health.subscriptionCost, 120, '/api/health reflects the persisted value');

    const roi = await (await fetch(`${BASE}/api/roi`)).json();
    assert.equal(roi.subscriptionCost, 120, '/api/roi computes against the persisted value');

    const snapshot = await (await fetch(`${BASE}/api/snapshot`)).json();
    assert.equal(snapshot.roi.subscriptionCost, 120, '/api/snapshot ROI block uses the persisted value');

    const persisted = JSON.parse(await readFile(`${home}/.clauge/config.json`, 'utf8'));
    assert.deepEqual(persisted, { v: 1, subscriptionCost: 120 });
  });
});
