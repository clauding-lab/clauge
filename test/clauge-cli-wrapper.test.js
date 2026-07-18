// Tests for src-tauri/Resources/clauge-cli — the bundled macOS CLI wrapper.
//
// The repo tree is NOT the installed bundle (AGENT_LEARNINGS 2026-07-16):
// Tauri copies the wrapper to `Contents/Resources/Resources/clauge-cli`
// (nested — the `resources:` copy preserves the `Resources/` prefix) and
// ships the externalBin UNSUFFIXED at `Contents/MacOS/clauge-server`, while
// MAS builds relocate the sidecar to
// `Contents/Helpers/Clauge Helper.app/Contents/MacOS/clauge-server`.
// PATH mechanisms (install_cli_symlink, Homebrew binary stanza) invoke the
// wrapper THROUGH A SYMLINK, so `dirname "$0"` alone resolves outside the
// bundle. Each staged layout below exists to pin one of those facts.
//
// POSIX-only: the wrapper is /bin/sh and macOS-bundle-specific — skip on
// Windows so the js-tests-windows PR gate doesn't spawn a shell it lacks.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, writeFile, rm, copyFile, chmod, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const WRAPPER_SRC = join(REPO_ROOT, 'src-tauri', 'Resources', 'clauge-cli');
// Derive the suffix the same way the wrapper does (uname -m), not from
// process.arch — a Rosetta node on arm64 would otherwise stage the wrong name.
const UNAME_M =
  process.platform === 'win32' ? '' : execFileSync('uname', ['-m']).toString().trim();
const SUFFIX =
  UNAME_M === 'arm64' || UNAME_M === 'aarch64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';

const SKIP_REASON =
  process.platform === 'win32' ? 'wrapper is a POSIX sh script (platform: win32)' : false;

let tmpRoot;

beforeEach(async () => {
  tmpRoot = join(os.tmpdir(), `clauge-wrapper-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

// Stage a fake Clauge.app with the wrapper at `wrapperRel` and a stub
// sidecar (echoes its own $0 + args, exit 0) at each of `binRels`.
// Returns the absolute wrapper path.
async function stageBundle({ wrapperRel, binRels }) {
  const app = join(tmpRoot, 'Clauge.app');
  const wrapper = join(app, wrapperRel);
  await mkdir(dirname(wrapper), { recursive: true });
  await copyFile(WRAPPER_SRC, wrapper);
  await chmod(wrapper, 0o755);
  for (const rel of binRels) {
    const bin = join(app, rel);
    await mkdir(dirname(bin), { recursive: true });
    await writeFile(bin, `#!/bin/sh\nprintf 'STUB_OK %s\\n' "$0"\nprintf 'ARGS %s\\n' "$*"\nexit 0\n`, 'utf8');
    await chmod(bin, 0o755);
  }
  return wrapper;
}

function run(cmd, args = []) {
  return spawnSync(cmd, args, { encoding: 'utf8' });
}

describe('clauge-cli wrapper — bundled layouts', { skip: SKIP_REASON }, () => {
  test('DMG layout: nested Resources/Resources wrapper finds unsuffixed Contents/MacOS sidecar', async () => {
    const wrapper = await stageBundle({
      wrapperRel: 'Contents/Resources/Resources/clauge-cli',
      binRels: ['Contents/MacOS/clauge-server'],
    });
    const r = run(wrapper, ['config', 'get']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /STUB_OK .*Contents\/MacOS\/clauge-server/);
    assert.match(r.stdout, /ARGS config get/);
  });

  test('MAS layout: wrapper finds the Helper.app sidecar', async () => {
    const wrapper = await stageBundle({
      wrapperRel: 'Contents/Resources/Resources/clauge-cli',
      binRels: ['Contents/Helpers/Clauge Helper.app/Contents/MacOS/clauge-server'],
    });
    const r = run(wrapper, ['config', 'get']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /STUB_OK .*Helpers\/Clauge Helper\.app\/Contents\/MacOS\/clauge-server/);
  });

  test('legacy layout: un-nested Resources wrapper + suffixed binary still resolves', async () => {
    const wrapper = await stageBundle({
      wrapperRel: 'Contents/Resources/clauge-cli',
      binRels: [`Contents/MacOS/clauge-server-${SUFFIX}`],
    });
    const r = run(wrapper, ['config', 'get']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`STUB_OK .*Contents/MacOS/clauge-server-${SUFFIX}`));
  });

  test('symlinked invocation (absolute target): /usr/local/bin-style symlink resolves back into the bundle', async () => {
    const wrapper = await stageBundle({
      wrapperRel: 'Contents/Resources/Resources/clauge-cli',
      binRels: ['Contents/MacOS/clauge-server'],
    });
    const binDir = join(tmpRoot, 'usr-local-bin');
    await mkdir(binDir, { recursive: true });
    const link = join(binDir, 'clauge');
    await symlink(wrapper, link); // absolute target, like install_cli_symlink
    const r = run(link, ['config', 'get']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /STUB_OK .*Contents\/MacOS\/clauge-server/);
  });

  test('symlinked invocation (relative target, chained): Homebrew-style link-to-link resolves', async () => {
    const wrapper = await stageBundle({
      wrapperRel: 'Contents/Resources/Resources/clauge-cli',
      binRels: ['Contents/MacOS/clauge-server'],
    });
    const binDir = join(tmpRoot, 'brew-bin');
    await mkdir(binDir, { recursive: true });
    const hop = join(binDir, 'clauge-hop');
    // relative target from binDir into the bundle
    await symlink(join('..', 'Clauge.app', 'Contents', 'Resources', 'Resources', 'clauge-cli'), hop);
    const link = join(binDir, 'clauge');
    await symlink('clauge-hop', link); // second hop, also relative
    const r = run(link, ['config', 'get']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /STUB_OK .*Contents\/MacOS\/clauge-server/);
  });

  test('no sidecar anywhere: exit 1 with a "not found" message', async () => {
    const wrapper = await stageBundle({
      wrapperRel: 'Contents/Resources/Resources/clauge-cli',
      binRels: [],
    });
    const r = run(wrapper, ['config', 'get']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not found/);
  });
});
