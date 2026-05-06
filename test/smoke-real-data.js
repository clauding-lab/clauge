/**
 * Smoke test: parse a real Claude Code session JSONL from ~/.claude.
 * Not run by `npm test` (lives outside test/ glob to keep CI hermetic).
 * Usage: node test/smoke-real-data.js [/path/to/session.jsonl]
 */

import { parseSession } from '../lib/parser.js';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';

async function pickSampleFile() {
  const root = join(homedir(), '.claude', 'projects');
  const dirs = await readdir(root, { withFileTypes: true });
  const matches = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const projDir = join(root, d.name);
    const files = await readdir(projDir);
    for (const f of files) {
      if (f.endsWith('.jsonl')) matches.push(join(projDir, f));
    }
  }
  matches.sort();
  return matches[Math.floor(matches.length / 2)] ?? null;
}

const arg = process.argv[2];
const file = arg ? resolve(arg) : await pickSampleFile();
if (!file) {
  console.error('No JSONL files found in ~/.claude/projects/*/');
  process.exit(1);
}

console.log(`File: ${file}`);
const t0 = performance.now();
const turns = await parseSession(file);
const elapsed = (performance.now() - t0).toFixed(1);

const assistant = turns.filter((t) => t.type === 'assistant');
const user = turns.filter((t) => t.type === 'user');

const byModel = new Map();
const totals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheCreate5m: 0,
  cacheCreate1h: 0,
  webSearches: 0,
  webFetches: 0,
};
for (const t of assistant) {
  const u = t.usage ?? {};
  for (const k of Object.keys(totals)) totals[k] += u[k] ?? 0;
  byModel.set(t.model, (byModel.get(t.model) ?? 0) + 1);
}

const summary = {
  parseTimeMs: Number(elapsed),
  totalRecords: turns.length,
  assistantTurns: assistant.length,
  userTurns: user.length,
  uniqueRequestIds: new Set(assistant.map((t) => t.requestId)).size,
  modelDistribution: Object.fromEntries(byModel),
  tokenTotals: totals,
  cwd: assistant[0]?.cwd ?? null,
  gitBranch: assistant[0]?.gitBranch ?? null,
  version: assistant[0]?.version ?? null,
  contentBlocksPerTurnSample: assistant.slice(0, 3).map((t) => ({
    requestId: t.requestId,
    blocks: t.contentBlocks.map((b) => b.type),
  })),
};

console.log(JSON.stringify(summary, null, 2));

// Sanity: assistantTurns must equal uniqueRequestIds (perfect dedup)
if (summary.assistantTurns !== summary.uniqueRequestIds) {
  console.error(
    `\nDEDUP MISMATCH: ${summary.assistantTurns} turns vs ${summary.uniqueRequestIds} unique requestIds`
  );
  process.exit(2);
}
console.log('\nDedup invariant OK: 1 turn per unique requestId');
