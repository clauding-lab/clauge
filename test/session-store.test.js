// Unit tests for lib/session-store.js — specifically the cold-start memory
// safety of loadAllSummaries().
//
// Incident (2026-06-13): on a large ~/.claude (1.1 GB across 2647 session
// files) the original unbounded `Promise.all(files.map(loadSummary))` parsed
// the entire transcript corpus concurrently. Peak transient parse memory hit
// ~4 GB and OOM-killed the sidecar within ~50 s of a single cold-cache request
// (warm-cache steady state is ~57 MB — the blow-up is purely the unbounded
// fan-out, not retained data). Sub-project B's always-on alert poller hits this
// path every 30 s from launch, turning a latent dashboard-only crash into an
// every-launch crash loop. loadAllSummaries must therefore cap how many files
// it parses at once. These tests pin that contract.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore, SUMMARY_LOAD_CONCURRENCY } from '../lib/session-store.js';

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'clauge-session-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Seed n empty .jsonl files under <dir>/projects/p1 so listFiles() finds them.
// Contents are irrelevant — every test below overrides loadSummary().
async function seedFiles(n) {
  const projDir = join(dir, 'projects', 'p1');
  await mkdir(projDir, { recursive: true });
  for (let i = 0; i < n; i++) {
    await writeFile(join(projDir, `s${i}.jsonl`), '');
  }
}

// A SessionStore whose loadSummary records peak concurrency instead of parsing.
function countingStore(claudeDir, onCall = () => {}) {
  let inFlight = 0;
  const seen = { max: 0 };
  class CountingStore extends SessionStore {
    async loadSummary(filePath) {
      inFlight++;
      seen.max = Math.max(seen.max, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // hold the slot open
      inFlight--;
      onCall(filePath);
      return { file: filePath };
    }
  }
  return { store: new CountingStore({ claudeDir }), seen };
}

describe('loadAllSummaries — cold-start concurrency cap', () => {
  it('exposes the chosen positive-integer concurrency cap', () => {
    assert.equal(typeof SUMMARY_LOAD_CONCURRENCY, 'number');
    assert.ok(Number.isInteger(SUMMARY_LOAD_CONCURRENCY));
    assert.ok(SUMMARY_LOAD_CONCURRENCY > 0);
    // Pin the value. A careless bump to a much larger cap would re-open the
    // cold-start OOM this fix closes (the concurrency test below saturates the
    // cap regardless of its value, so only this assertion guards the number).
    // Changing the cap must be a conscious edit here.
    assert.equal(SUMMARY_LOAD_CONCURRENCY, 8);
  });

  it('never parses more than the cap of files at once, and returns them all', async () => {
    const n = SUMMARY_LOAD_CONCURRENCY + 5;
    await seedFiles(n);
    const { store, seen } = countingStore(dir);

    const summaries = await store.loadAllSummaries();

    assert.equal(summaries.length, n, 'returns every summary');
    assert.ok(
      seen.max <= SUMMARY_LOAD_CONCURRENCY,
      `max in-flight ${seen.max} exceeded cap ${SUMMARY_LOAD_CONCURRENCY}`
    );
    assert.equal(
      seen.max,
      SUMMARY_LOAD_CONCURRENCY,
      'should saturate the cap when there is more work than slots'
    );
  });

  it('returns [] when there are no session files', async () => {
    // No projects dir at all.
    assert.deepEqual(await new SessionStore({ claudeDir: dir }).loadAllSummaries(), []);
    // projects dir exists but contains zero .jsonl files.
    await seedFiles(0);
    assert.deepEqual(await new SessionStore({ claudeDir: dir }).loadAllSummaries(), []);
  });

  it('handles a single file (below the cap)', async () => {
    await seedFiles(1);
    const { store, seen } = countingStore(dir);
    const out = await store.loadAllSummaries();
    assert.equal(out.length, 1);
    assert.equal(seen.max, 1);
  });

  it('handles exactly the cap in a single full batch', async () => {
    await seedFiles(SUMMARY_LOAD_CONCURRENCY);
    const { store, seen } = countingStore(dir);
    const out = await store.loadAllSummaries();
    assert.equal(out.length, SUMMARY_LOAD_CONCURRENCY);
    assert.equal(seen.max, SUMMARY_LOAD_CONCURRENCY);
  });

  it('drops only the failing file — by identity, in a later batch — and logs it', async () => {
    const n = SUMMARY_LOAD_CONCURRENCY + 2; // 2 batches: forces the failure past batch 1
    await seedFiles(n);
    // Pick the failing file from the SAME ordering loadAllSummaries iterates,
    // at an index in the second batch — independent of readdir order.
    const files = await new SessionStore({ claudeDir: dir }).listFiles();
    const badPath = files[SUMMARY_LOAD_CONCURRENCY].file;

    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      class FlakyStore extends SessionStore {
        async loadSummary(filePath) {
          if (filePath === badPath) throw new Error('corrupt session file');
          return { file: filePath };
        }
      }
      const out = await new FlakyStore({ claudeDir: dir }).loadAllSummaries();

      assert.equal(out.length, n - 1, 'exactly one file excluded');
      assert.ok(
        !out.some((s) => s.file === badPath),
        'the corrupt file is the one dropped'
      );
      assert.ok(
        errors.some((line) => line.includes(badPath)),
        'the failure was logged for the corrupt file'
      );
    } finally {
      console.error = origError;
    }
  });
});
