import { describe, it, before } from 'node:test';
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

const SKIP_SMOKE = process.env.SKIP_SEA_SMOKE === '1';

describe('SEA sidecar smoke', { skip: SKIP_SMOKE ? 'SKIP_SEA_SMOKE=1 set' : false }, () => {
  before(() => {
    if (!existsSync(SIDECAR)) {
      console.log('[smoke] Building SEA sidecar (one-time)...');
      execSync('node scripts/build-sidecar.mjs', { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  });

  it('binary is executable and starts within 2s', async () => {
    const child = spawn(SIDECAR, [], {
      env: { ...process.env, PORT: '3520', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    // Buffer stderr continuously from spawn so the marker can't be missed.
    child.stderr.on('data', (b) => { stderrBuf += b.toString(); });

    try {
      // Wait deterministically for both startup markers in parallel:
      //   stdout: "Listening on ..."
      //   stderr: "CLAUGE_BOUND_PORT=3520"
      // Streams are independent — buffering stderr from spawn (above) and
      // racing both promises avoids the prior sleep(100) hack.
      const stderrPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stderr marker timeout')), 5000);
        // If the marker is already in the buffer (fast path), resolve immediately.
        if (/CLAUGE_BOUND_PORT=3520/.test(stderrBuf)) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const onData = () => {
          if (/CLAUGE_BOUND_PORT=3520/.test(stderrBuf)) {
            clearTimeout(timer);
            child.stderr.off('data', onData);
            resolve();
          }
        };
        child.stderr.on('data', onData);
      });

      const stdoutPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stdout marker timeout')), 5000);
        const onData = (b) => {
          if (b.toString().includes('Listening on')) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve();
          }
        };
        child.stdout.on('data', onData);
      });

      await Promise.all([stdoutPromise, stderrPromise]);

      // The stderrPromise above already verified the regex matched; assert
      // again here for documentation and to surface the buffer in failures.
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
    } finally {
      // Hard cleanup guarantee: regardless of which assertion threw above,
      // make sure the spawned process is gone before the test returns.
      try { child.kill('SIGKILL'); } catch {}
      // Await exit with a short safety timeout so the test never hangs.
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        sleep(2000),
      ]);
    }
  });
});
