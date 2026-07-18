// Integration tests for GET /v1/usage — the public loopback contract, exercised
// against a real spawned server (harness copied from test/server-additions.test.js).
// CLAUGE_HOME + CLAUDE_DIR point at empty temp dirs so the cold-install state is
// real, then an ingest POST (real claude.ai wire shape) flips it to the data state.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];
// Ports must be unique across ALL test files — node --test runs files in
// parallel, and 3493/3494 already belong to cors-allowlist/path-trim (grep
// `const PORT` + `PORT:` across test/ before picking; the full map spans
// 3493-3541). Each describe also gets its own port so the second spawn never
// races the first one's SIGTERM teardown.
let PORT = 3550;

async function startServer(envOverrides = {}) {
  const child = spawn(SERVER_BIN, SERVER_ARGS, {
    env: { ...process.env, NO_OPEN: '1', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Diagnostics for flake hunts: if the server dies mid-suite, say why —
  // an unexplained ECONNREFUSED in a later test is otherwise undebuggable.
  let stderrBuf = '';
  child.stderr.on('data', (b) => { stderrBuf += b.toString(); });
  child.on('exit', (code, signal) => {
    if (!child.expectedExit) {
      console.error(
        `[server-v1] spawned server died unexpectedly: code=${code} signal=${signal}\n` +
          `[server-v1] stderr:\n${stderrBuf || '(empty)'}`
      );
    }
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
    child.expectedExit = true;
    child.kill('SIGKILL');
    throw err;
  }
}

function stopServer(child) {
  if (child && !child.killed) {
    child.expectedExit = true;
    child.kill('SIGTERM');
  }
}

// fetch() (undici) refuses to override Host — the rebinding test needs raw http.
function rawGet(path, { host } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: PORT, path, method: 'GET', ...(host ? { headers: { Host: host } } : {}) },
      (res) => {
        let body = '';
        res.on('data', (b) => { body += b; });
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// Real producer shape (what the Clauge Sync extension POSTs — utilization +
// resets_at, snake_case), NOT the normalized internal shape.
const INGEST_FIXTURE = {
  org: { uuid: 'org-v1-test', name: 'V1 Test Org' },
  usage: {
    five_hour: { utilization: 20, resets_at: '2026-07-18T14:00:00Z' },
    seven_day: { utilization: 9, resets_at: '2026-07-23T12:00:00Z' },
    seven_day_opus: { utilization: 41, resets_at: '2026-07-23T12:00:00Z' },
  },
};

describe('/v1/usage — cold install (no data ever ingested)', () => {
  let server;
  let home;
  let claudeDir;
  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'clauge-v1-cold-home-'));
    claudeDir = await mkdtemp(join(tmpdir(), 'clauge-v1-cold-claude-'));
    // HOME/USERPROFILE too: UsageStore resolves ~/.clauge/usage.json via
    // os.homedir(), which CLAUGE_HOME does NOT redirect — without this the
    // "cold" server reads the developer's real usage.json.
    server = await startServer({
      PORT: String(PORT),
      CLAUGE_HOME: home,
      CLAUDE_DIR: claudeDir,
      HOME: home,
      USERPROFILE: home,
    });
  });
  after(async () => {
    stopServer(server);
    await rm(home, { recursive: true, force: true });
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('GET /v1/usage returns 200 [] — empty array, never 204, for the array form', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/usage`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  it('GET /v1/usage/claude returns 204 no body', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/usage/claude`);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
  });

  it('GET /v1/usage/unknown returns 404 provider_not_found', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/usage/unknown`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'provider_not_found' });
  });

  it('a request with Host: evil.com is rejected 403 (DNS-rebinding guard)', async () => {
    const res = await rawGet('/v1/usage', { host: 'evil.com' });
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: 'forbidden_host' });
  });

  it('loopback Host values with the live port are accepted', async () => {
    const res = await rawGet('/v1/usage', { host: `localhost:${PORT}` });
    assert.equal(res.status, 200);
  });
});

describe('/v1/usage — after a real ingest', () => {
  let server;
  let home;
  let claudeDir;
  before(async () => {
    PORT = 3551;
    home = await mkdtemp(join(tmpdir(), 'clauge-v1-data-home-'));
    claudeDir = await mkdtemp(join(tmpdir(), 'clauge-v1-data-claude-'));
    server = await startServer({
      PORT: String(PORT),
      CLAUGE_HOME: home,
      CLAUDE_DIR: claudeDir,
      HOME: home,
      USERPROFILE: home,
    });
    const res = await fetch(`http://127.0.0.1:${PORT}/api/usage/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(INGEST_FIXTURE),
    });
    assert.equal(res.status, 200, 'fixture must ingest cleanly');
  });
  after(async () => {
    stopServer(server);
    await rm(home, { recursive: true, force: true });
    await rm(claudeDir, { recursive: true, force: true });
  });

  it('GET /v1/usage returns one claude snapshot with the locked envelope + lines', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/usage`);
    assert.equal(res.status, 200);
    const snaps = await res.json();
    assert.equal(snaps.length, 1);
    const snap = snaps[0];
    assert.equal(snap.apiVersion, 1);
    assert.equal(snap.providerId, 'claude');
    assert.equal(snap.displayName, 'Claude');
    assert.equal(typeof snap.fetchedAt, 'string');
    assert.ok(!('error' in snap));

    const session = snap.lines.find((l) => l.label === 'Session');
    assert.equal(session.type, 'progress');
    assert.equal(session.used, 20);
    assert.equal(session.limit, 100);
    assert.deepEqual(session.format, { kind: 'percent' });
    assert.equal(session.resets_at, '2026-07-18T14:00:00Z');

    const opus = snap.lines.find((l) => l.label === 'Weekly (Opus)');
    assert.equal(opus.used, 41);
    assert.ok(!snap.lines.some((l) => l.label === 'Weekly (Sonnet)'), 'absent window ⇒ no line');
  });

  it('serves the additive ROI (30d) line alongside the frozen 7d ROI line', async () => {
    // The tmp HOME has no session summaries, so both windows see $0 of
    // API-equivalent value against the default $200 subscription — the
    // point here is WIRING (both lines present, both labels), not values.
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/usage`);
    const [snap] = await res.json();
    const weekly = snap.lines.find((l) => l.label === 'ROI');
    const monthly = snap.lines.find((l) => l.label === 'ROI (30d)');
    assert.equal(weekly.type, 'text');
    assert.equal(monthly.type, 'text');
    assert.match(monthly.value, /x vs API$/);
  });

  it('GET /v1/usage/claude returns the same single snapshot', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/usage/claude`);
    assert.equal(res.status, 200);
    const snap = await res.json();
    assert.equal(snap.providerId, 'claude');
    assert.equal(snap.apiVersion, 1);
  });

  it('no-Origin scripted GET is served and carries no CORS allow header', async () => {
    const res = await rawGet('/v1/usage');
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});
