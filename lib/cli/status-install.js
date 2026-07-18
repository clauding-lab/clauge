// `clauge status --install` — wire the Clauge Widget into Claude Code's
// statusLine (~/.claude/settings.json). Civility rules copied from aiusage's
// setup.py (spec §4, rev 4 — the widget REPLACES tools like ccstatusline, so
// the switch must be deliberate):
//   1. bail untouched on invalid JSON — never "fix" a file we can't parse
//   2. refuse to clobber a DIFFERENT statusLine without --force, and NAME it
//   3. back up the existing file before any write
//
// settings.json belongs to Claude Code, not Clauge — merge, never rewrite
// beyond the statusLine key.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * The command Claude Code should invoke per render. SEA builds are their
 * own executable (`clauge-server status`); plain-node runs (npx / dev)
 * need the script path too. Paths are quoted — the app installs under
 * /Applications with no spaces today, but the npm prefix is anyone's guess.
 */
async function installCommand() {
  let isSea = false;
  try {
    const sea = await import('node:sea');
    isSea = sea.isSea();
  } catch {
    isSea = false;
  }
  const exec = process.execPath;
  const script = process.argv[1];
  if (isSea || !script) return `"${exec}" status`;
  return `"${exec}" "${script}" status`;
}

function settingsFileFor(env) {
  const dir = (env.CLAUDE_DIR ?? path.join(os.homedir(), '.claude')).replace(
    /^~(?=\/)/,
    os.homedir(),
  );
  return path.join(dir, 'settings.json');
}

export async function runInstall({ flags, env = process.env }) {
  const settingsFile = settingsFileFor(env);
  const command = await installCommand();

  let raw = null;
  try {
    raw = await readFile(settingsFile, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      process.stderr.write(`clauge: cannot read ${settingsFile}: ${e?.message ?? e}\n`);
      return 1;
    }
  }

  let settings = {};
  if (raw !== null) {
    try {
      settings = JSON.parse(raw);
    } catch {
      process.stderr.write(
        `clauge: ${settingsFile} contains invalid JSON — not touching it. Fix the file and re-run.\n`,
      );
      return 1;
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      process.stderr.write(
        `clauge: ${settingsFile} is not a JSON object — not touching it.\n`,
      );
      return 1;
    }
  }

  const existing = settings.statusLine;
  if (existing?.type === 'command' && existing?.command === command) {
    process.stdout.write('clauge: statusLine already installed — nothing to do.\n');
    return 0;
  }
  if (existing !== undefined && flags.force !== true) {
    const name =
      typeof existing?.command === 'string' ? existing.command : JSON.stringify(existing);
    process.stderr.write(
      `clauge: a different statusLine is already configured: ${name}\n` +
        'Re-run with --force to replace it (the current settings.json is backed up first).\n',
    );
    return 1;
  }

  if (raw !== null) {
    await writeFile(`${settingsFile}.backup`, raw, 'utf8');
  }

  const next = { ...settings, statusLine: { type: 'command', command } };
  await mkdir(path.dirname(settingsFile), { recursive: true });
  // Atomic write (unique tmp + rename) — settings.json is shared state and
  // a torn write would break every Claude Code launch, not just the widget.
  const tmp = `${settingsFile}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmp, settingsFile);

  const replaced =
    existing !== undefined && typeof existing?.command === 'string'
      ? ` (replaced ${existing.command})`
      : '';
  process.stdout.write(`clauge: statusLine installed${replaced} → ${settingsFile}\n`);
  return 0;
}
