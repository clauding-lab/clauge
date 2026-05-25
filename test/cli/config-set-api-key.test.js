// Tests for lib/cli/config-set-api-key.js. The actual `security`
// shell-out is mocked via the ioOpts injection so we don't touch the
// user's real Keychain in tests.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../../lib/cli/config-set-api-key.js';

function makeIo({ platform = 'darwin', stdin = '', securityShouldFail = false } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  let securityCalledWith = null;
  return {
    opts: {
      platform,
      readStdin: async () => stdin,
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: (s) => stderrChunks.push(s),
      securityCmd: async (args) => {
        securityCalledWith = args;
        if (securityShouldFail) throw new Error('security mock failure');
      },
    },
    out: () => stdoutChunks.join(''),
    err: () => stderrChunks.join(''),
    securityArgs: () => securityCalledWith,
  };
}

describe('config set-api-key — validation', () => {
  test('refuses without --stdin', async () => {
    const io = makeIo();
    const code = await run(
      { flags: { provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 2);
    assert.match(io.err(), /argv/i);
  });

  test('refuses unknown provider', async () => {
    const io = makeIo({ stdin: 'key' });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-oauth' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 2);
    assert.match(io.err(), /anthropic-admin only/i);
  });

  test('refuses on non-darwin platforms', async () => {
    const io = makeIo({ platform: 'linux', stdin: 'key' });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 2);
    assert.match(io.err(), /macOS-only/i);
  });

  test('refuses empty stdin', async () => {
    const io = makeIo({ stdin: '' });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 2);
    assert.match(io.err(), /empty/i);
  });

  test('refuses whitespace-only stdin', async () => {
    const io = makeIo({ stdin: '   \n\t  \n' });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 2);
    assert.match(io.err(), /empty/i);
  });

  test('refuses oversized stdin (>4096 chars)', async () => {
    const io = makeIo({ stdin: 'x'.repeat(4097) });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 2);
    assert.match(io.err(), /too|long|suspiciously/i);
  });
});

describe('config set-api-key — happy path (mocked security)', () => {
  test('passes correct args to security', async () => {
    const io = makeIo({ stdin: 'sk-ant-test-key' });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 0);
    const args = io.securityArgs();
    assert.deepEqual(args, [
      'add-generic-password',
      '-s', 'com.clauding.clauge.anthropic-admin-key',
      '-a', process.env.USER || 'clauge',
      '-w', 'sk-ant-test-key',
      '-U',
    ]);
  });

  test('trims trailing whitespace before storing', async () => {
    const io = makeIo({ stdin: 'sk-ant-test\n' });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 0);
    const args = io.securityArgs();
    const wIdx = args.indexOf('-w');
    assert.equal(args[wIdx + 1], 'sk-ant-test');
  });

  test('prints forward-looking warning to stderr', async () => {
    const io = makeIo({ stdin: 'sk-ant-test' });
    await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.match(io.err(), /forward-looking/i);
  });

  test('returns exit 1 if security fails', async () => {
    const io = makeIo({ stdin: 'sk-ant-test', securityShouldFail: true });
    const code = await run(
      { flags: { stdin: true, provider: 'anthropic-admin' }, positional: [] },
      io.opts,
    );
    assert.equal(code, 1);
    assert.match(io.err(), /Keychain write failed/i);
  });
});
