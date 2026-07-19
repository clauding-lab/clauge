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
 * need the script path too. Paths are shell-quoted — the command string is
 * later executed via the shell, so POSIX gets single-quote escaping (a
 * naive "…" still interpolates $, `, \") while cmd.exe keeps double quotes.
 */
function shellQuote(p) {
  if (process.platform === 'win32') return `"${p}"`;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Homebrew serves binaries from a version-addressed keg
 * (<prefix>/Cellar/<formula>/<version>/…) behind a stable
 * <prefix>/opt/<formula> symlink. `process.execPath` resolves through to the
 * keg, and `brew upgrade` DELETES old kegs — persisting the resolved path
 * killed the statusline on every upgrade (AGENT_LEARNINGS 2026-07-19).
 * Persist the stable alias instead; non-brew paths pass through untouched.
 */
export function stabilizeBrewPath(p) {
  return p.replace(/^(\/opt\/homebrew|\/usr\/local)\/Cellar\/([^/]+)\/[^/]+\//, '$1/opt/$2/');
}

async function installCommand() {
  let isSea = false;
  try {
    const sea = await import('node:sea');
    isSea = sea.isSea();
  } catch {
    isSea = false;
  }
  const exec = stabilizeBrewPath(process.execPath);
  const script = process.argv[1];
  if (isSea || !script) return `${shellQuote(exec)} status`;
  return `${shellQuote(exec)} ${shellQuote(stabilizeBrewPath(script))} status`;
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
