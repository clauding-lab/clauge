import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const PORT = '3494';
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

describe('path-leak trim', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => { if (server && !server.killed) server.kill('SIGTERM'); });

  it('/api/health no longer exposes claudeDir', async () => {
    const body = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    assert.equal(body.claudeDir, undefined, 'claudeDir must be absent from /api/health');
    assert.equal(body.service, 'clauge');
  });

  it('/api/config STILL exposes claudeDir (local CLI consumer)', async () => {
    const body = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json();
    assert.ok(typeof body.claudeDir === 'string', 'claudeDir kept on /api/config');
  });

  it('/api/sessions summaries no longer carry filePath', async () => {
    const body = await (await fetch(`http://127.0.0.1:${PORT}/api/sessions`)).json();
    for (const s of body.sessions ?? []) {
      assert.equal(s.filePath, undefined, 'filePath must be stripped from session summaries');
    }
  });
});
