import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = '3493';

function startServer() {
  const child = spawn('node', ['server.js'], {
    env: { ...process.env, NO_OPEN: '1', PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('start timeout')), 5000);
    child.stdout.on('data', (b) => {
      if (b.toString().includes('Listening on')) { clearTimeout(timer); resolve(child); }
    });
  });
}

// GET with an explicit Origin header; resolves the ACAO response header (or null).
function getWithOrigin(path, origin, method = 'GET', extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extraHeaders };
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port: Number(PORT), path, method, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] ?? null });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('read-only CORS allowlist', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => { if (server && !server.killed) server.kill('SIGTERM'); });

  it('rejects a foreign website origin (no ACAO)', async () => {
    const r = await getWithOrigin('/api/health', 'https://evil.example');
    assert.notEqual(r.acao, 'https://evil.example');
    assert.notEqual(r.acao, '*');
  });

  it('reflects a 127.0.0.1 loopback origin', async () => {
    const o = `http://127.0.0.1:${PORT}`;
    const r = await getWithOrigin('/api/health', o);
    assert.equal(r.acao, o);
  });

  it('reflects a localhost loopback origin (extension opens dashboard via localhost)', async () => {
    const o = `http://localhost:${PORT}`;
    const r = await getWithOrigin('/api/health', o);
    assert.equal(r.acao, o);
  });

  it('still answers the ingest OPTIONS preflight for the extension origin', async () => {
    const r = await getWithOrigin('/api/usage/ingest', 'chrome-extension://abcdefg', 'OPTIONS', {
      'Access-Control-Request-Method': 'POST',
    });
    assert.equal(r.status, 204);
    assert.equal(r.acao, 'chrome-extension://abcdefg');
  });
});
