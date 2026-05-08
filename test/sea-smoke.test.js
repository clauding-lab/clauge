import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const SIDECAR = join(REPO_ROOT, 'src-tauri', 'binaries', `clauge-server-${ARCH}-apple-darwin`);

describe('SEA sidecar smoke', () => {
  before(() => {
    if (!existsSync(SIDECAR)) {
      console.log('[smoke] Building SEA sidecar (one-time)...');
      execSync('bash scripts/build-sidecar.sh', { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  });

  it('binary is executable and starts within 2s', async () => {
    const child = spawn(SIDECAR, [], {
      env: { ...process.env, PORT: '3520', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    child.stderr.on('data', (b) => { stderrBuf += b.toString(); });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('start timeout')), 2500);
      const onData = (b) => {
        if (b.toString().includes('Listening on')) {
          clearTimeout(t);
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
    });

    // server.js writes 'Listening on' to stdout BEFORE 'CLAUGE_BOUND_PORT=' to
    // stderr. Yield to the event loop so the stderr 'data' handler can fire
    // before we read the buffer. (Streams are independent; both messages may
    // already be in the kernel pipe but only the stdout 'data' event has fired
    // when the await above resolves.)
    await sleep(100);

    assert.match(stderrBuf, /CLAUGE_BOUND_PORT=3520/);

    const health = await fetch('http://127.0.0.1:3520/api/health');
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.service, 'clauge');

    const summary = await fetch('http://127.0.0.1:3520/api/sessions?period=7d');
    assert.equal(summary.status, 200);

    const exitPromise = new Promise((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGTERM');
    const code = await Promise.race([exitPromise, sleep(2500).then(() => 'TIMEOUT')]);
    assert.equal(code, 0, 'clean exit on SIGTERM');
  });
});
