// `clauge config enable --provider <name>` — turn a provider ON.

import { toggleProvider } from './_toggle.js';

export async function run(parsed) {
  const name = parsed.flags.provider || parsed.positional[0];
  if (!name) {
    process.stderr.write('usage: clauge config enable --provider <name>\n');
    return 2;
  }
  return toggleProvider({ name, enabled: true });
}
