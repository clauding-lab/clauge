// Tests for lib/cli/status.js — orchestration: port discovery, the §4
// degrade ladder, the stale cache, stdin handling, --json exit codes,
// compaction counting, git branch. CLAUGE_HOME sandboxes every path;
// fetch/stdin/clock/env are injected via the deps seam (pattern:
// test/cli/config-get.test.js).

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import os from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const NOW = Date.parse('2026-07-18T12:00:00Z');

let tmpHome;
let originalHome;

async function withCleanTmpHome() {
  tmpHome = path.join(os.tmpdir(), `clauge-status-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await rm(tmpHome, { recursive: true, force: true });
  await mkdir(tmpHome, { recursive: true });
  originalHome = process.env.CLAUGE_HOME;
  process.env.CLAUGE_HOME = tmpHome;
}

async function restoreHome() {
  if (originalHome === undefined) delete process.env.CLAUGE_HOME;
  else process.env.CLAUGE_HOME = originalHome;
  if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
}

async function freshModule() {
  return await import(`../../lib/cli/status.js?t=${Date.now()}-${Math.random()}`);
}

async function stagePortFile(port) {
  const cp = await import(`../../lib/config-paths.js?t=${Date.now()}-port`);
  const p = cp.configPaths.portFile();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, String(port), 'utf8');
}

function cacheFilePath() {
  return path.join(tmpHome, '.clauge', 'statusline-cache.json');
}

const SNAPSHOT = {
  apiVersion: 1,
  providerId: 'claude',
  displayName: 'Claude',
  plan: null,
  fetchedAt: new Date(NOW - 60_000).toISOString(),
  lines: [
    {
      type: 'progress',
      label: 'Session',
      used: 20,
      limit: 100,
      format: { kind: 'percent' },
      resets_at: new Date(NOW + 2 * 3600_000).toISOString(),
    },
    { type: 'text', label: 'Spend', value: '$664 this window' },
    { type: 'text', label: 'ROI (30d)', value: '17.3x vs API' },
  ],
};

const okFetch = async () =>
  new Response(JSON.stringify([SNAPSHOT]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const deadFetch = async () => {
  throw new Error('ECONNREFUSED');
};

function parsed(flags = {}) {
  return { verb: 'status', subverb: null, flags, positional: [] };
}

async function capture(fn) {
  const outOrig = process.stdout.write.bind(process.stdout);
  const errOrig = process.stderr.write.bind(process.stderr);
  const out = [];
  const err = [];
  process.stdout.write = (c) => (out.push(c.toString()), true);
  process.stderr.write = (c) => (err.push(c.toString()), true);
  try {
    const code = await fn();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = outOrig;
    process.stderr.write = errOrig;
  }
}

function baseDeps(overrides = {}) {
  return {
    fetchImpl: okFetch,
    stdinText: null,
    nowMs: NOW,
    // Plain output by default so assertions read byte-for-byte; the color
    // pipeline itself is covered by status-render.test.js and the explicit
    // flag tests below.
    env: { NO_COLOR: '1' },
    gitBranch: async () => null,
    ...overrides,
  };
}

describe('degrade ladder — exit 0 on every rung', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('sidecar live: renders quota + money lines and exits 0', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { code, stdout } = await capture(() => mod.run(parsed(), baseDeps()));
    assert.equal(code, 0);
    assert.match(stdout, /Session .*20%/);
    assert.match(stdout, /\$664 this window · ROI 17\.3× vs API/);
  });

  test('no port file and no cache: dim notice, exit 0', async () => {
    const mod = await freshModule();
    const { code, stdout } = await capture(() => mod.run(parsed(), baseDeps()));
    assert.equal(code, 0);
    assert.match(stdout, /clauge: app not running/);
  });

  test('port file present but connection fails, no cache: notice, exit 0', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { code, stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ fetchImpl: deadFetch })),
    );
    assert.equal(code, 0);
    assert.match(stdout, /clauge: app not running/);
  });

  test('a 500 response is a failure rung, not a crash', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { code, stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ fetchImpl: async () => new Response('boom', { status: 500 }) })),
    );
    assert.equal(code, 0);
    assert.match(stdout, /clauge: app not running/);
  });

  test('a non-JSON 200 body is a failure rung, not a crash', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { code, stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ fetchImpl: async () => new Response('<html>', { status: 200 }) })),
    );
    assert.equal(code, 0);
    assert.match(stdout, /clauge: app not running/);
  });
});

describe('stale cache — write-through on success, serve on failure', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('a successful render writes ~/.clauge/statusline-cache.json', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    await capture(() => mod.run(parsed(), baseDeps()));
    const cache = JSON.parse(await readFile(cacheFilePath(), 'utf8'));
    assert.equal(typeof cache.savedAt, 'string');
    assert.equal(cache.snapshots[0].providerId, 'claude');
  });

  test('connection failure serves the cache with an age tag', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    await capture(() => mod.run(parsed(), baseDeps()));
    const { code, stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ fetchImpl: deadFetch, nowMs: NOW + 12 * 60_000 })),
    );
    assert.equal(code, 0);
    assert.match(stdout, /\$664 this window/);
    assert.match(stdout, /· 12m old/);
  });

  test('cache serves even when the port file is gone (app quit removes it)', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    await capture(() => mod.run(parsed(), baseDeps()));
    const cp = await import(`../../lib/config-paths.js?t=${Date.now()}-rm`);
    await rm(cp.configPaths.portFile(), { force: true });
    const { code, stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ fetchImpl: deadFetch, nowMs: NOW + 5 * 60_000 })),
    );
    assert.equal(code, 0);
    assert.match(stdout, /\$664 this window/);
    assert.match(stdout, /· 5m old/);
  });

  test('a corrupt cache falls back to the notice — guarded read, exit 0', async () => {
    await mkdir(dirname(cacheFilePath()), { recursive: true });
    await writeFile(cacheFilePath(), '{ torn write', 'utf8');
    const mod = await freshModule();
    const { code, stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ fetchImpl: deadFetch })),
    );
    assert.equal(code, 0);
    assert.match(stdout, /clauge: app not running/);
  });
});

describe('stdin payload — load-bearing but never required', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  const stdinPayload = JSON.stringify({
    transcript_path: null,
    model: { display_name: 'Opus 4.8' },
    workspace: { current_dir: '/opt/work' },
    cost: { total_duration_ms: 60_000, total_lines_added: 5, total_lines_removed: 1 },
    context_window: { used_percentage: 46 },
  });

  test('a piped payload renders line 1 + Context Used', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ stdinText: stdinPayload })),
    );
    assert.match(stdout, /^Opus 4\.8 · \/opt\/work · \+5\/-1 · ⧗ 1m\n/);
    assert.match(stdout, /Context Used 46%/);
  });

  test('malformed stdin JSON degrades to the API-only render, exit 0', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { code, stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ stdinText: '{ not json' })),
    );
    assert.equal(code, 0);
    assert.ok(!stdout.includes('Opus'));
    assert.match(stdout, /\$664 this window/);
  });

  test('git branch from the payload cwd lands in line 1', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { stdout } = await capture(() =>
      mod.run(
        parsed(),
        baseDeps({
          stdinText: stdinPayload,
          gitBranch: async (dir) => (dir === '/opt/work' ? 'main' : null),
        }),
      ),
    );
    assert.match(stdout, /⧗ 1m · main\n/);
  });
});

describe('compaction counting — structural, not substring', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('counts compact_boundary system entries and ignores decoy message text', async () => {
    const transcript = path.join(tmpHome, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto' } }),
      JSON.stringify({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'summary' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'we discussed "subtype":"compact_boundary" markers' } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } }),
    ];
    await writeFile(transcript, lines.join('\n') + '\n', 'utf8');
    await stagePortFile(34567);
    const mod = await freshModule();
    const stdin = JSON.stringify({ transcript_path: transcript, model: { display_name: 'Opus' } });
    const { stdout } = await capture(() => mod.run(parsed(), baseDeps({ stdinText: stdin })));
    assert.match(stdout, /Compactions 2/);
  });

  test('an unreadable transcript omits the segment instead of crashing', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const stdin = JSON.stringify({ transcript_path: path.join(tmpHome, 'missing.jsonl') });
    const { code, stdout } = await capture(() => mod.run(parsed(), baseDeps({ stdinText: stdin })));
    assert.equal(code, 0);
    assert.ok(!stdout.includes('Compactions'));
  });
});

describe('resolveGitBranch — real git, no mocks', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('returns the branch of a repo and null for a non-repo', async () => {
    const repo = path.join(tmpHome, 'repo');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
    const mod = await freshModule();
    assert.equal(await mod.resolveGitBranch(repo), 'main');
    assert.equal(await mod.resolveGitBranch(tmpHome), null);
  });
});

describe('--json — scripts must be able to detect failure', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('success prints the /v1/usage envelope verbatim (2-space, newline-terminated), exit 0', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { code, stdout } = await capture(() =>
      mod.run(parsed({ json: true }), baseDeps()),
    );
    assert.equal(code, 0);
    assert.equal(stdout, JSON.stringify([SNAPSHOT], null, 2) + '\n');
  });

  test('the same failing fetch that renders exit 0 makes --json exit non-zero', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const render = await capture(() => mod.run(parsed(), baseDeps({ fetchImpl: deadFetch })));
    const json = await capture(() => mod.run(parsed({ json: true }), baseDeps({ fetchImpl: deadFetch })));
    assert.equal(render.code, 0);
    assert.equal(json.code, 1);
    assert.match(json.stderr, /app not running/);
    assert.equal(json.stdout, '');
  });

  test('--json does not serve the stale cache — live data or failure', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    await capture(() => mod.run(parsed(), baseDeps()));
    const { code, stdout } = await capture(() =>
      mod.run(parsed({ json: true }), baseDeps({ fetchImpl: deadFetch })),
    );
    assert.equal(code, 1);
    assert.equal(stdout, '');
  });
});

describe('flags', () => {
  beforeEach(withCleanTmpHome);
  afterEach(restoreHome);

  test('NO_COLOR in the env strips every escape sequence', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { stdout } = await capture(() =>
      mod.run(parsed(), baseDeps({ env: { NO_COLOR: '1', TERM: 'xterm-256color' } })),
    );
    assert.ok(!stdout.includes('\x1b['));
  });

  test('--plain strips escapes even on a 256-color terminal', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { stdout } = await capture(() =>
      mod.run(parsed({ plain: true }), baseDeps({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' } })),
    );
    assert.ok(!stdout.includes('\x1b['));
  });

  test('--max-width caps visible line length', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const { stdout } = await capture(() =>
      mod.run(parsed({ 'max-width': '30', plain: true }), baseDeps()),
    );
    for (const line of stdout.trimEnd().split('\n')) {
      assert.ok([...line].length <= 30, `${line} exceeds 30`);
    }
  });

  test('--provider claude renders; an unknown provider gets a notice, exit 0', async () => {
    await stagePortFile(34567);
    const mod = await freshModule();
    const ok = await capture(() => mod.run(parsed({ provider: 'claude' }), baseDeps()));
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /\$664/);
    const unknown = await capture(() => mod.run(parsed({ provider: 'openai' }), baseDeps()));
    assert.equal(unknown.code, 0);
    assert.match(unknown.stdout, /openai/);
  });
});
