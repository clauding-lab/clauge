// `clauge config set-api-key --provider <name> --stdin` — store an API
// key in the macOS Keychain.
//
// v0.9.3 scope: --provider anthropic-admin only. The Keychain item is
// forward-looking — no current Clauge version reads it. It will be
// consumed by v0.10.0 IAP / billing flows.
//
// Why --stdin only: passing a secret on argv puts it in shell history.
// stdin is the only safe channel.
//
// Why macOS-only: Windows + Linux Keychain equivalents need different
// mechanisms (`cmdkey` / libsecret). Tracked for v0.9.4.
//
// Security note: this implementation shells out to `security
// add-generic-password -w <key>`. The key briefly appears in the
// security process's argv (visible via `ps`) during the spawn. Small
// window, but not zero. v0.9.4 will switch to a Node Keychain library
// (keytar) that uses the Keychain Services API directly.

import { spawn } from 'node:child_process';
import { configPaths } from '../config-paths.js';

const MAX_KEY_LENGTH = 4096;

async function readStdinUtf8() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function runSecurity(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('security', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `security exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

export async function run(parsed, ioOpts = {}) {
  const platform = ioOpts.platform || process.platform;
  const readStdin = ioOpts.readStdin || readStdinUtf8;
  const writeStdout = ioOpts.writeStdout || ((s) => process.stdout.write(s));
  const writeStderr = ioOpts.writeStderr || ((s) => process.stderr.write(s));
  const securityCmd = ioOpts.securityCmd || runSecurity;

  if (!parsed.flags.stdin) {
    writeStderr(
      'refusing to read API key from argv. Pipe the key into stdin and pass --stdin:\n' +
        '  echo "$KEY" | clauge config set-api-key --provider anthropic-admin --stdin\n',
    );
    return 2;
  }

  const provider = parsed.flags.provider;
  if (provider !== 'anthropic-admin') {
    writeStderr(`set-api-key currently supports --provider anthropic-admin only (got: ${provider || '<missing>'})\n`);
    return 2;
  }

  if (platform !== 'darwin') {
    writeStderr(
      `set-api-key is currently macOS-only (detected platform: ${platform}).\n` +
        'Windows + Linux Keychain support tracked for v0.9.4.\n',
    );
    return 2;
  }

  const raw = await readStdin();
  const key = raw.trim();
  if (!key) {
    writeStderr('empty API key — stdin produced nothing usable\n');
    return 2;
  }
  if (key.length > MAX_KEY_LENGTH) {
    writeStderr(`API key suspiciously long (${key.length} chars) — refusing\n`);
    return 2;
  }

  const service = configPaths.keychainItems.anthropicAdmin;
  const account = process.env.USER || 'clauge';

  try {
    await securityCmd([
      'add-generic-password',
      '-s', service,
      '-a', account,
      '-w', key,
      '-U', // update in place if the item already exists
    ]);
  } catch (e) {
    writeStderr(`Keychain write failed: ${e.message || e}\n`);
    return 1;
  }

  writeStdout(`stored ${service} in macOS Keychain (account: ${account})\n`);
  writeStderr(
    'NOTE: this Keychain item is forward-looking — no current Clauge version reads it yet.\n' +
      '      It will be consumed by v0.10.0 IAP / billing flows.\n',
  );
  return 0;
}
