import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

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
    // Hold port 3500 with a dummy listener so server has to fall back
    blocker = createServer().listen(3500);
    await new Promise((r) => blocker.once('listening', r));
    server = await startServer({ PORT: '3500' });
  });

  after(() => {
    server?.kill('SIGTERM');
    blocker?.close();
  });

  it('falls back to next port when configured port is busy', async () => {
    // Server should have logged "Listening on" with port 3501
    const res = await fetch('http://127.0.0.1:3501/api/health');
    assert.equal(res.status, 200);
  });

  it('exposes chosen port via stderr line for Tauri to parse', async () => {
    const child = spawn(SERVER_BIN, SERVER_ARGS, {
      env: { ...process.env, PORT: '3502', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    child.stderr.on('data', (b) => { stderrBuf += b.toString(); });
    await sleep(800);
    child.kill('SIGTERM');
    assert.match(stderrBuf, /CLAUGE_BOUND_PORT=3502/);
  });
});
