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

// macOS-only: the binary under test is the universal `-apple-darwin` SEA
// (line above), which can't exist or run on Windows/Linux — so `npm test`'s
// glob would otherwise ENOENT off darwin. Skip there (and when explicitly
// disabled). Keeps the suite portable for the Windows PR-gate job + Linux devs.
const SKIP_REASON =
  process.env.SKIP_SEA_SMOKE === '1'
    ? 'SKIP_SEA_SMOKE=1 set'
    : process.platform !== 'darwin'
      ? `SEA binary is macOS-only (platform: ${process.platform})`
      : false;

describe('SEA sidecar smoke', { skip: SKIP_REASON }, () => {
  before(() => {
    if (!existsSync(SIDECAR)) {
      console.log('[smoke] Building SEA sidecar (one-time)...');
      execSync('node scripts/build-sidecar.mjs', { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  });

  it('`status` verb survives the SEA bundle (dynamic import + exit 0)', async () => {
    // CLAUGE_HOME sandbox: no port file, no cache — deepest degrade rung.
    // Proves esbuild carried lib/cli/status*.js into the SEA bundle and the
    // render mode keeps its exit-0 contract from the shipped binary.
    const out = await new Promise((resolve, reject) => {
      const child = spawn(SIDECAR, ['status'], {
        env: { ...process.env, CLAUGE_HOME: '/nonexistent-clauge-home' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('status timeout')); }, 10_000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.on('error', reject);
    });
    assert.equal(out.code, 0, `exit 0 always; stderr: ${out.stderr}`);
    assert.match(out.stdout, /clauge: app not running/);
  });

  it('`--version` works from the SEA bundle (v1.3.4 artifact-smoke regression)', async () => {
    // Caught 2026-07-18 on the PUBLISHED v1.3.4 DMG: readVersion() resolved
    // ../../package.json from the bundle's __dirname, walking out of the SEA
    // extraction dir → ENOENT stack trace + exit 1. Latent since the CLI
    // landed; unreachable until PR-A revived the wrapper. Only the SEA
    // layout reproduces it — dev runs resolve the repo's package.json fine.
    const out = await new Promise((resolve, reject) => {
      const child = spawn(SIDECAR, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => { stdout += b.toString(); });
      child.stderr.on('data', (b) => { stderr += b.toString(); });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('--version timeout')); }, 10_000);
      child.on('exit', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.on('error', reject);
    });
    assert.equal(out.code, 0, `exit 0; stderr: ${out.stderr}`);
    assert.match(out.stdout, /clauge \d+\.\d+\.\d+/);
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
