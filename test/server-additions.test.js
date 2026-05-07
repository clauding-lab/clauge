import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

async function startServer(envOverrides = {}) {
  const child = spawn(SERVER_BIN, SERVER_ARGS, {
    env: { ...process.env, NO_OPEN: '1', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for "Listening on" line on stdout
  await new Promise((resolve, reject) => {
    const onData = (buf) => {
      if (buf.toString().includes('Listening on')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });
  return child;
}

describe('GET /api/health', () => {
  let server;
  before(async () => { server = await startServer({ PORT: '3499' }); });
  after(() => { server.kill('SIGTERM'); });

  it('returns 200 with service identity', async () => {
    const res = await fetch('http://127.0.0.1:3499/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, 'clauge');
    assert.ok(typeof body.version === 'string', 'version is a string');
    assert.ok(typeof body.pid === 'number', 'pid is a number');
  });
});
