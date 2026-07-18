// Tests for lib/cli/index.js — the dispatcher. Parses argv, routes to
// subcommands, handles --help / --version, prints usage on unknown
// verbs, returns a process-exit code.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { runCli, parseArgs } from '../../lib/cli/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
);

function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const lines = [];
  process.stdout.write = (chunk) => {
    lines.push(chunk.toString());
    return true;
  };
  try {
    return { result: fn(), output: lines.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function captureStdoutAsync(fn) {
  const original = process.stdout.write.bind(process.stdout);
  const lines = [];
  process.stdout.write = (chunk) => {
    lines.push(chunk.toString());
    return true;
  };
  try {
    const result = await fn();
    return { result, output: lines.join('') };
  } finally {
    process.stdout.write = original;
  }
}

async function captureStderrAsync(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(chunk.toString());
    return true;
  };
  try {
    const result = await fn();
    return { result, output: lines.join('') };
  } finally {
    process.stderr.write = original;
  }
}

describe('parseArgs', () => {
  test('returns { verb: null } for empty argv', () => {
    assert.deepEqual(parseArgs([]), { verb: null, subverb: null, flags: {}, positional: [] });
  });

  test('captures the top-level verb', () => {
    const parsed = parseArgs(['config']);
    assert.equal(parsed.verb, 'config');
    assert.equal(parsed.subverb, null);
  });

  test('captures verb + subverb', () => {
    const parsed = parseArgs(['config', 'get']);
    assert.equal(parsed.verb, 'config');
    assert.equal(parsed.subverb, 'get');
  });

  test('parses --flag value', () => {
    const parsed = parseArgs(['config', 'enable', '--provider', 'anthropic-oauth']);
    assert.equal(parsed.flags.provider, 'anthropic-oauth');
  });

  test('parses --flag=value', () => {
    const parsed = parseArgs(['config', 'enable', '--provider=anthropic-oauth']);
    assert.equal(parsed.flags.provider, 'anthropic-oauth');
  });

  test('parses bare --flag as true', () => {
    const parsed = parseArgs(['config', 'reset-trial', '--yes']);
    assert.equal(parsed.flags.yes, true);
  });

  test('collects positional args after the subverb', () => {
    const parsed = parseArgs(['config', 'get', 'extra']);
    assert.deepEqual(parsed.positional, ['extra']);
  });
});

describe('runCli — --version', () => {
  test('prints package.json version and exits 0', async () => {
    const { result, output } = await captureStdoutAsync(() => runCli(['--version']));
    assert.equal(result, 0);
    assert.ok(
      output.includes(packageJson.version),
      `output (${output}) should include version ${packageJson.version}`,
    );
  });

  test('-v is equivalent to --version', async () => {
    const { result, output } = await captureStdoutAsync(() => runCli(['-v']));
    assert.equal(result, 0);
    assert.ok(output.includes(packageJson.version));
  });
});

describe('runCli — --help', () => {
  test('prints usage and exits 0', async () => {
    const { result, output } = await captureStdoutAsync(() => runCli(['--help']));
    assert.equal(result, 0);
    assert.match(output, /usage: clauge/i);
    assert.match(output, /config\s+/i);
  });

  test('-h is equivalent to --help', async () => {
    const { result, output } = await captureStdoutAsync(() => runCli(['-h']));
    assert.equal(result, 0);
    assert.match(output, /usage: clauge/i);
  });

  test('bare invocation (no args) prints usage and exits 0', async () => {
    const { result, output } = await captureStdoutAsync(() => runCli([]));
    assert.equal(result, 0);
    assert.match(output, /usage: clauge/i);
  });

  test('config (verb without subverb) prints usage and exits 0', async () => {
    const { result, output } = await captureStdoutAsync(() => runCli(['config']));
    assert.equal(result, 0);
    assert.match(output, /clauge config/i);
    assert.match(output, /\bget\b/);
    assert.match(output, /\bproviders\b/);
  });
});

describe('runCli — status verb (Clauge Widget)', () => {
  test('usage text advertises the status verb and its flags', async () => {
    const { output } = await captureStdoutAsync(() => runCli(['--help']));
    assert.match(output, /\bstatus\b/);
    assert.match(output, /--json/);
    assert.match(output, /--install/);
  });

  test('status routes to the widget and exits 0 even with no app and no cache', async () => {
    // CLAUGE_HOME sandbox: no port file, no cache — the deepest degrade rung.
    const tmp = join(os.tmpdir(), `clauge-dispatch-status-${process.pid}-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    const prev = process.env.CLAUGE_HOME;
    process.env.CLAUGE_HOME = tmp;
    try {
      const { result, output } = await captureStdoutAsync(() => runCli(['status']));
      assert.equal(result, 0);
      assert.match(output, /clauge: app not running/);
    } finally {
      if (prev === undefined) delete process.env.CLAUGE_HOME;
      else process.env.CLAUGE_HOME = prev;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('runCli — unknown verbs', () => {
  test('unknown top-level verb prints error and exits 2', async () => {
    const { result, output } = await captureStderrAsync(() => runCli(['nonsense']));
    assert.equal(result, 2);
    assert.match(output, /unknown command/i);
    assert.match(output, /nonsense/);
  });

  test('unknown config subverb prints error and exits 2', async () => {
    const { result, output } = await captureStderrAsync(() => runCli(['config', 'nonsense']));
    assert.equal(result, 2);
    assert.match(output, /unknown/i);
    assert.match(output, /nonsense/);
  });
});
