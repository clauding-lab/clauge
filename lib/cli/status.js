// `clauge status` — the Clauge Widget (spec rev 4, §4 contract LOCKED).
// Orchestration only: stdin payload, port discovery, the 250 ms /v1 fetch,
// the stale cache, git branch, compaction count. All rendering lives in
// status-render.js (pure); the --install flow lives in status-install.js.
//
// Exit-code contract (§4): the render mode exits 0 ALWAYS — a statusline
// host treats non-zero as breakage. --json is for scripts and exits 1 on
// fetch/parse failure so callers can detect "app not running".

import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { configPaths } from '../config-paths.js';
import { fetchWithTimeout } from '../http.js';
import { readActivePort } from './active-port.js';
import { renderStatus } from './status-render.js';

// §3: measured warm round-trip is ~90 ms end-to-end; 250 ms is ~3× headroom
// and fails fast enough to stay inside a statusline render budget. The
// existing config CLI's 2000 ms would freeze the host's statusline.
const HTTP_TIMEOUT_MS = 250;
const STDIN_TIMEOUT_MS = 150;
const STDIN_MAX_BYTES = 1024 * 1024;
// Transcripts are read whole for the compaction count; past this cap the
// segment is omitted (honest omission beats a blown render budget).
const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 300;

const NOTICE = 'clauge: app not running';

/**
 * Read the piped statusLine payload without ever blocking a hand-run
 * invocation: TTY stdin (a human at a shell) is skipped outright, a silent
 * pipe is abandoned after STDIN_TIMEOUT_MS, and input is size-capped.
 */
function readStdinBounded() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin || stdin.isTTY) return resolve(null);
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.pause();
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(chunks.length ? Buffer.concat(chunks).toString('utf8') : null),
      STDIN_TIMEOUT_MS,
    );
    stdin.on('data', (chunk) => {
      size += chunk.length;
      if (size <= STDIN_MAX_BYTES) chunks.push(chunk);
    });
    stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stdin.on('error', () => finish(null));
  });
}

function parsePayload(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Current git branch of `dir`, or null on any failure (non-repo, no git,
 * timeout). Exported for tests — exercised against a real repo, no mocks.
 */
export async function resolveGitBranch(dir) {
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', dir, 'branch', '--show-current'],
        { timeout: GIT_TIMEOUT_MS },
        (err, stdout) => (err ? reject(err) : resolve({ stdout })),
      );
    });
    const branch = stdout.trim();
    return branch === '' ? null : branch;
  } catch {
    return null;
  }
}

// Structural count, not substring: transcripts can legitimately DISCUSS
// compaction (this session's own transcript does), so a bare
// `includes('compact_boundary')` overcounts. The substring is only the
// cheap pre-filter; the JSON shape {type:'system',subtype:'compact_boundary'}
// is the verified marker (measured 2026-07-18, one entry per compaction).
function countCompactBoundaries(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('compact_boundary')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'system' && entry?.subtype === 'compact_boundary') count += 1;
    } catch {
      // A torn or non-JSON line is not a boundary.
    }
  }
  return count;
}

async function countCompactions(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return null;
  try {
    const info = await stat(transcriptPath);
    if (!info.isFile() || info.size > TRANSCRIPT_MAX_BYTES) return null;
    return countCompactBoundaries(await readFile(transcriptPath, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchSnapshots(fetchImpl) {
  const port = await readActivePort();
  if (port === null) return null;
  try {
    const res = await fetchWithTimeout(
      `http://127.0.0.1:${port}/v1/usage`,
      {},
      HTTP_TIMEOUT_MS,
      fetchImpl,
    );
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

// Stale cache: write-through on success, guarded read on failure. The write
// is atomic via a UNIQUE tmp name + rename — statusline renders overlap
// under rapid re-render, and two writers sharing one tmp path could tear.
async function writeCache(snapshots, nowMs) {
  try {
    const file = configPaths.statuslineCacheFile();
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const payload = { savedAt: new Date(nowMs).toISOString(), snapshots };
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  } catch {
    // A failed cache write must never break the render (exit-0 contract).
  }
}

async function readCache(nowMs) {
  try {
    const raw = await readFile(configPaths.statuslineCacheFile(), 'utf8');
    const parsed = JSON.parse(raw);
    const savedAtMs = Date.parse(parsed?.savedAt);
    if (!Number.isFinite(savedAtMs) || !Array.isArray(parsed?.snapshots)) return null;
    return { snapshots: parsed.snapshots, ageMs: Math.max(0, nowMs - savedAtMs) };
  } catch {
    return null;
  }
}

function parseMaxWidth(flag) {
  const n = parseInt(flag, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Dispatcher entrypoint. `deps` is the test seam (injected fetch, stdin,
 * clock, env, git) — production callers pass nothing.
 */
export async function run(parsed, deps = {}) {
  const {
    fetchImpl = globalThis.fetch,
    stdinText,
    nowMs = Date.now(),
    env = process.env,
    gitBranch = resolveGitBranch,
  } = deps;
  const flags = parsed.flags ?? {};

  if (flags.install) {
    const mod = await import('./status-install.js');
    return mod.runInstall({ flags, env });
  }

  const jsonMode = flags.json === true;

  // stdin necessarily comes first (git/transcript need the payload's dir and
  // transcript_path); the remaining three sources then run concurrently, so
  // the worst case is stdin + max(fetch 250ms, git 300ms, transcript read).
  // --json uses none of the stdin-sourced data — skip the read entirely so
  // script callers with an open-but-silent pipe don't pay STDIN_TIMEOUT_MS.
  const text = jsonMode ? null : stdinText !== undefined ? stdinText : await readStdinBounded();
  const payload = parsePayload(text);
  const dir = payload?.workspace?.current_dir ?? payload?.cwd;
  const [live, branch, compactions] = await Promise.all([
    fetchSnapshots(fetchImpl),
    typeof dir === 'string' && dir !== '' && !jsonMode ? gitBranch(dir) : null,
    !jsonMode ? countCompactions(payload?.transcript_path) : null,
  ]);

  if (jsonMode) {
    // Scripts must detect failure: live envelope or non-zero — never the
    // stale cache (§4 --json contract, deliberately unlike the render mode).
    if (!live) {
      process.stderr.write(`${NOTICE}\n`);
      return 1;
    }
    process.stdout.write(JSON.stringify(live, null, 2) + '\n');
    return 0;
  }

  try {
    let snapshots = live;
    let cacheAgeMs = null;
    if (snapshots && snapshots.length > 0) {
      await writeCache(snapshots, nowMs);
    } else if (snapshots) {
      // [] means the app is up but usage was NEVER ingested — an honest
      // "no data" state. Render it truthfully below, but never let it
      // clobber a good cache (review P3, 2026-07-18).
    } else {
      const cached = await readCache(nowMs);
      if (cached) {
        snapshots = cached.snapshots;
        cacheAgeMs = cached.ageMs;
      }
    }

    const provider = typeof flags.provider === 'string' ? flags.provider : 'claude';
    const snapshot = snapshots?.find((s) => s?.providerId === provider) ?? null;
    if (snapshots && !snapshot) {
      process.stdout.write(`clauge: no data for provider '${provider}'\n`);
      return 0;
    }

    const ansi = !(flags.plain === true || (env.NO_COLOR != null && env.NO_COLOR !== ''));
    const orange256 =
      Boolean(env.COLORTERM) || String(env.TERM ?? '').includes('256color');
    const out = renderStatus(
      {
        payload,
        snapshot,
        branch,
        compactions,
        cacheAgeMs,
        nowMs,
        homeDir: os.homedir(),
      },
      { ansi, orange256, maxWidth: parseMaxWidth(flags['max-width']) },
    );
    process.stdout.write(out + '\n');
  } catch {
    // The render mode never error-spams the host — degrade to the notice.
    process.stdout.write(`${NOTICE}\n`);
  }
  return 0;
}
