// Companion CLI dispatcher. Parses argv, routes to subcommands,
// returns an exit code (does NOT call process.exit — server.js does).
//
// Verb shape:
//   clauge --help | -h | --version | -v
//   clauge config get | providers | enable | disable | set-api-key | reset-trial
//
// The full subcommand catalogue (enable / disable / set-api-key /
// reset-trial) is wired in subsequent commits; this dispatcher is
// ready for them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Lazy-load package.json once so --version is one disk read per CLI run.
let cachedVersion = null;
function readVersion() {
  if (cachedVersion !== null) return cachedVersion;
  const pkgPath = join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  cachedVersion = pkg.version;
  return cachedVersion;
}

const CONFIG_SUBVERBS = new Set([
  'get',
  'providers',
  'enable',
  'disable',
  'set-api-key',
  'reset-trial',
]);

/**
 * Parse argv into { verb, subverb, flags, positional }.
 * Pure function — no side effects. argv excludes node + script name.
 */
export function parseArgs(argv) {
  const out = { verb: null, subverb: null, flags: {}, positional: [] };
  if (argv.length === 0) return out;

  out.verb = argv[0];
  let i = 1;

  // Capture subverb if the verb has one and the next arg isn't a flag.
  if (out.verb === 'config' && i < argv.length && !argv[i].startsWith('-')) {
    out.subverb = argv[i];
    i += 1;
  }

  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq >= 0) {
        out.flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        out.flags[arg.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        out.flags[arg.slice(2)] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flag like -v, -h.
      out.flags[arg.slice(1)] = true;
    } else {
      out.positional.push(arg);
    }
    i += 1;
  }
  return out;
}

function printUsage(stream = process.stdout) {
  const text = [
    'usage: clauge [--help|--version] <command> [args]',
    '',
    'Commands:',
    '  status                     Render the Clauge Widget statusline',
    '  status --json              Print the /v1/usage envelope for scripts',
    '  status --install           Wire into ~/.claude/settings.json (statusLine)',
    '  config get                 Print Clauge config as JSON',
    '  config providers           List providers + connection status',
    '  config enable --provider   Turn a provider on',
    '  config disable --provider  Turn a provider off',
    '  config set-api-key --provider X --stdin  Store an API key from stdin',
    '  config reset-trial         Wipe trial counter (dev-mode only)',
    '',
    'Options:',
    '  -h, --help                 Show this help',
    '  -v, --version              Show version',
    '',
    'See README "Command-line interface" for examples.',
    '',
  ].join('\n');
  stream.write(text);
}

function printConfigUsage(stream = process.stdout) {
  const text = [
    'usage: clauge config <subcommand>',
    '',
    'Subcommands:',
    '  get          Print current config as JSON',
    '  providers    List providers + connection status',
    '  enable       Turn a provider on',
    '  disable      Turn a provider off',
    '  set-api-key  Store an API key (read from stdin)',
    '  reset-trial  Wipe trial counter (dev-mode only)',
    '',
  ].join('\n');
  stream.write(text);
}

/**
 * Dispatch a parsed argv to the appropriate subcommand handler.
 * Returns the process exit code (0 = success, 2 = usage error,
 * 1 = runtime failure).
 */
export async function runCli(argv) {
  const parsed = parseArgs(argv);

  // Top-level flags / no-args.
  if (parsed.flags.version || parsed.flags.v || parsed.verb === '--version' || parsed.verb === '-v') {
    process.stdout.write(`clauge ${readVersion()}\n`);
    return 0;
  }
  if (parsed.flags.help || parsed.flags.h || parsed.verb === '--help' || parsed.verb === '-h' || parsed.verb === null) {
    printUsage();
    return 0;
  }

  if (parsed.verb === 'status') {
    // The Clauge Widget (spec rev 4). status.js owns the exit-code
    // contract: render mode is exit-0-always, --json is non-zero on
    // failure, --install returns the civility-flow codes.
    try {
      const mod = await import('./status.js');
      return await mod.run(parsed);
    } catch (e) {
      process.stderr.write(`error in status: ${e?.message || e}\n`);
      return 1;
    }
  }

  if (parsed.verb === 'config') {
    if (parsed.subverb === null) {
      printConfigUsage();
      return 0;
    }
    if (!CONFIG_SUBVERBS.has(parsed.subverb)) {
      process.stderr.write(`unknown subcommand: config ${parsed.subverb}\n`);
      printConfigUsage(process.stderr);
      return 2;
    }
    // Dynamic import — keeps the dispatcher small + lets subcommands
    // load only on demand. Subverb modules are wired in subsequent commits.
    try {
      const mod = await import(`./config-${parsed.subverb}.js`);
      return await mod.run(parsed);
    } catch (e) {
      if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
        process.stderr.write(`subcommand not yet implemented: config ${parsed.subverb}\n`);
        return 2;
      }
      process.stderr.write(`error in config ${parsed.subverb}: ${e?.message || e}\n`);
      return 1;
    }
  }

  process.stderr.write(`unknown command: ${parsed.verb}\n`);
  printUsage(process.stderr);
  return 2;
}
