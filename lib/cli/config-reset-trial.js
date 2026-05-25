// `clauge config reset-trial [--yes]` — wipe the trial-counter Keychain
// item. Three independent locks protect against accidental invocation:
//
//   1. Dev-mode gate. Refuse unless ONE of:
//        - CLAUGE_DEV=1 in the environment, OR
//        - settings.json has { "dev_mode": true }
//   2. Confirmation prompt (interactive) UNLESS --yes is passed.
//   3. Platform gate (macOS only — `security delete-generic-password`).
//      Windows + Linux Keychain wipe is tracked for v0.9.4.
//
// "Already absent" is treated as success — idempotent so dev scripts
// can call it before AND after a test run without thinking about
// state.
//
// Forward-looking note: the trial-counter Keychain item doesn't yet
// exist in production builds (no current Clauge code writes it). This
// command is plumbing for v0.10.0 IAP work.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { configPaths } from '../config-paths.js';

function runSecurity(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('security', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      resolve({ code, stderr: stderr.trim() });
    });
    proc.on('error', reject);
  });
}

async function readSettingsDevMode() {
  try {
    const raw = await readFile(configPaths.settingsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return parsed.dev_mode === true;
  } catch {
    return false;
  }
}

async function promptYesNo(question) {
  // Use process.stdin via readline. Resolves to true on y/yes (any case).
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export async function run(parsed, ioOpts = {}) {
  const platform = ioOpts.platform || process.platform;
  const env = ioOpts.env || process.env;
  const settingsDevMode = ioOpts.settingsDevMode || readSettingsDevMode;
  const confirm = ioOpts.confirm || promptYesNo;
  const securityCmd = ioOpts.securityCmd || runSecurity;
  const writeStdout = ioOpts.writeStdout || ((s) => process.stdout.write(s));
  const writeStderr = ioOpts.writeStderr || ((s) => process.stderr.write(s));

  if (platform !== 'darwin') {
    writeStderr(
      `reset-trial is currently macOS-only (detected platform: ${platform}).\n` +
        'Windows + Linux Keychain wipe tracked for v0.9.4.\n',
    );
    return 2;
  }

  // Dev-mode gate.
  const envDev = env.CLAUGE_DEV === '1';
  const settingsDev = await settingsDevMode();
  if (!envDev && !settingsDev) {
    writeStderr(
      'reset-trial refused — dev-mode is not enabled.\n' +
        'Set CLAUGE_DEV=1 in the environment, or add "dev_mode": true to settings.json.\n' +
        'This guard is intentional — wiping the trial counter on a production user\n' +
        'would reset their trial state and likely lock them out of the paid features.\n',
    );
    return 2;
  }

  // Confirmation prompt unless --yes.
  if (!parsed.flags.yes) {
    const ok = await confirm(
      `Wipe Keychain item ${configPaths.keychainItems.trialCounter}? [y/N] `,
    );
    if (!ok) {
      writeStderr('aborted.\n');
      return 1;
    }
  }

  // Execute the wipe. Item-not-found (errSecItemNotFound, code 44) is success.
  const { code, stderr } = await securityCmd([
    'delete-generic-password',
    '-s', configPaths.keychainItems.trialCounter,
  ]);
  if (code === 0) {
    writeStdout(`wiped ${configPaths.keychainItems.trialCounter}\n`);
    return 0;
  }
  if (code === 44 || /could not be found|item not found/i.test(stderr)) {
    writeStdout(`${configPaths.keychainItems.trialCounter} not present (already wiped)\n`);
    return 0;
  }
  writeStderr(`Keychain wipe failed (exit ${code}): ${stderr || '<no stderr>'}\n`);
  return 1;
}
