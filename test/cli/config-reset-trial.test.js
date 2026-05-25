// Tests for lib/cli/config-reset-trial.js. The security shell-out,
// settings dev-mode read, and confirm prompt are all mocked via the
// ioOpts injection so the real Keychain isn't touched.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { run } from '../../lib/cli/config-reset-trial.js';

function makeIo({
  platform = 'darwin',
  envDev = false,
  settingsDev = false,
  confirmAnswer = true,
  securityCode = 0,
  securityStderr = '',
} = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  let securityCalledWith = null;
  let confirmCalled = false;
  return {
    opts: {
      platform,
      env: { CLAUGE_DEV: envDev ? '1' : undefined },
      settingsDevMode: async () => settingsDev,
      confirm: async () => {
        confirmCalled = true;
        return confirmAnswer;
      },
      securityCmd: async (args) => {
        securityCalledWith = args;
        return { code: securityCode, stderr: securityStderr };
      },
      writeStdout: (s) => stdoutChunks.push(s),
      writeStderr: (s) => stderrChunks.push(s),
    },
    out: () => stdoutChunks.join(''),
    err: () => stderrChunks.join(''),
    securityArgs: () => securityCalledWith,
    confirmCalled: () => confirmCalled,
  };
}

describe('reset-trial — platform gate', () => {
  test('refuses on linux', async () => {
    const io = makeIo({ platform: 'linux' });
    const code = await run({ flags: {} }, io.opts);
    assert.equal(code, 2);
    assert.match(io.err(), /macOS-only/i);
  });

  test('refuses on windows', async () => {
    const io = makeIo({ platform: 'win32' });
    const code = await run({ flags: {} }, io.opts);
    assert.equal(code, 2);
    assert.match(io.err(), /macOS-only/i);
  });
});

describe('reset-trial — dev-mode gate', () => {
  test('refuses without dev-mode (env nor settings)', async () => {
    const io = makeIo({ envDev: false, settingsDev: false });
    const code = await run({ flags: {} }, io.opts);
    assert.equal(code, 2);
    assert.match(io.err(), /dev-mode is not enabled/i);
  });

  test('allows when CLAUGE_DEV=1', async () => {
    const io = makeIo({ envDev: true });
    const code = await run({ flags: { yes: true } }, io.opts);
    assert.equal(code, 0);
  });

  test('allows when settings.json has dev_mode: true', async () => {
    const io = makeIo({ settingsDev: true });
    const code = await run({ flags: { yes: true } }, io.opts);
    assert.equal(code, 0);
  });
});

describe('reset-trial — confirmation prompt', () => {
  test('prompts when --yes is absent', async () => {
    const io = makeIo({ envDev: true, confirmAnswer: true });
    const code = await run({ flags: {} }, io.opts);
    assert.equal(code, 0);
    assert.equal(io.confirmCalled(), true);
  });

  test('aborts when prompt answer is no', async () => {
    const io = makeIo({ envDev: true, confirmAnswer: false });
    const code = await run({ flags: {} }, io.opts);
    assert.equal(code, 1);
    assert.match(io.err(), /aborted/i);
  });

  test('skips prompt when --yes is set', async () => {
    const io = makeIo({ envDev: true });
    const code = await run({ flags: { yes: true } }, io.opts);
    assert.equal(code, 0);
    assert.equal(io.confirmCalled(), false);
  });
});

describe('reset-trial — security execution', () => {
  test('calls security delete-generic-password with the trial-counter service', async () => {
    const io = makeIo({ envDev: true });
    await run({ flags: { yes: true } }, io.opts);
    assert.deepEqual(io.securityArgs(), [
      'delete-generic-password',
      '-s', 'com.clauding.clauge.trial-counter',
    ]);
  });

  test('treats item-not-found (exit 44) as success', async () => {
    const io = makeIo({ envDev: true, securityCode: 44 });
    const code = await run({ flags: { yes: true } }, io.opts);
    assert.equal(code, 0);
    assert.match(io.out(), /already wiped|not present/i);
  });

  test('treats "could not be found" stderr as success regardless of exit', async () => {
    const io = makeIo({
      envDev: true,
      securityCode: 1,
      securityStderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
    });
    const code = await run({ flags: { yes: true } }, io.opts);
    assert.equal(code, 0);
  });

  test('reports other security failures as exit 1', async () => {
    const io = makeIo({
      envDev: true,
      securityCode: 2,
      securityStderr: 'unexpected error',
    });
    const code = await run({ flags: { yes: true } }, io.opts);
    assert.equal(code, 1);
    assert.match(io.err(), /failed/i);
  });
});
