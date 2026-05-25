// `clauge config providers` — list providers + enabled state.
//
// Default output: aligned columns for human eyes.
// --json flag:    raw array, JSON.stringify'd.
//
// Reuses buildConfigOutput from config-get so HTTP-first + disk-fallback
// behavior stays consistent across read subcommands.

import { buildConfigOutput } from './config-get.js';

function pad(s, width) {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function renderTable(providers) {
  // Column widths sized to the data we have. Provider names are
  // kebab-case and short; status is "on"/"off"; displayName varies.
  const nameW = Math.max(8, ...providers.map((p) => p.name.length));
  const statusW = 3; // "on" / "off"

  const lines = [];
  lines.push(`${pad('PROVIDER', nameW)}  ${pad('STATUS', statusW)}  LABEL`);
  for (const p of providers) {
    const status = p.enabled ? 'on' : 'off';
    lines.push(`${pad(p.name, nameW)}  ${pad(status, statusW)}  ${p.displayName}`);
  }
  return lines.join('\n') + '\n';
}

export async function run(parsed) {
  const out = await buildConfigOutput();
  const providers = out.providers || [];

  if (parsed.flags.json) {
    process.stdout.write(JSON.stringify(providers, null, 2) + '\n');
    return 0;
  }

  if (!out.running) {
    process.stdout.write(
      'Clauge is not running — provider list reflects settings.json on disk, not live connection status.\n\n',
    );
  }
  process.stdout.write(renderTable(providers));
  return 0;
}
