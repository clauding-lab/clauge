import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseSession,
  normalizeUsage,
  decodeProjectDir,
  resolveProjectName,
} from '../lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLE = resolve(__dirname, 'fixtures/sample-session.jsonl');

describe('parseSession — requestId deduplication (PRD §2.3.1)', () => {
  it('collapses 3 lines sharing one requestId into a single assistant turn', async () => {
    const turns = await parseSession(SAMPLE);
    const assistantTurns = turns.filter((t) => t.type === 'assistant');
    assert.equal(assistantTurns.length, 2, 'two distinct requestIds');
    const reqAAA = assistantTurns.find((t) => t.requestId === 'req_AAA');
    assert.ok(reqAAA, 'req_AAA turn exists');
    assert.equal(
      reqAAA.contentBlocks.length,
      3,
      'aggregated 3 content blocks (thinking, text, tool_use)'
    );
  });

  it('does NOT triple-count usage for triplicated requestId', async () => {
    const turns = await parseSession(SAMPLE);
    const reqAAA = turns.find(
      (t) => t.type === 'assistant' && t.requestId === 'req_AAA'
    );
    assert.equal(
      reqAAA.usage.outputTokens,
      200,
      'output tokens taken from one line, not summed'
    );
    assert.equal(reqAAA.usage.inputTokens, 10);
    assert.equal(reqAAA.usage.cacheRead, 50000);
    assert.equal(reqAAA.usage.cacheCreate1h, 1000);
  });
});

describe('parseSession — record-type filtering (PRD §2.3.2)', () => {
  it('drops non-turn record types (system, file-history-snapshot, permission-mode)', async () => {
    const turns = await parseSession(SAMPLE);
    for (const t of turns) {
      assert.ok(
        t.type === 'assistant' || t.type === 'user',
        `unexpected type retained: ${t.type}`
      );
    }
  });

  it('keeps user turns', async () => {
    const turns = await parseSession(SAMPLE);
    const userTurns = turns.filter((t) => t.type === 'user');
    assert.equal(userTurns.length, 2);
  });
});

describe('parseSession — schema extraction', () => {
  it('extracts model from .message.model (not top-level)', async () => {
    const turns = await parseSession(SAMPLE);
    const reqAAA = turns.find(
      (t) => t.type === 'assistant' && t.requestId === 'req_AAA'
    );
    assert.equal(reqAAA.model, 'claude-opus-4-7');
    const reqBBB = turns.find(
      (t) => t.type === 'assistant' && t.requestId === 'req_BBB'
    );
    assert.equal(reqBBB.model, 'claude-sonnet-4-6');
  });

  it('preserves cwd, gitBranch, version metadata', async () => {
    const turns = await parseSession(SAMPLE);
    const turn = turns.find((t) => t.type === 'assistant');
    assert.equal(turn.cwd, '/Users/test/Projects/sample');
    assert.equal(turn.gitBranch, 'main');
    assert.equal(turn.version, '2.1.121');
  });

  it('sorts turns by timestamp', async () => {
    const turns = await parseSession(SAMPLE);
    for (let i = 1; i < turns.length; i++) {
      assert.ok(
        turns[i - 1].timestamp <= turns[i].timestamp,
        'timestamps non-decreasing'
      );
    }
  });
});

describe('normalizeUsage — two-tier cache structure', () => {
  it('separates 5-minute and 1-hour cache creation tokens', () => {
    const raw = {
      input_tokens: 100,
      output_tokens: 500,
      cache_read_input_tokens: 10000,
      cache_creation: {
        ephemeral_5m_input_tokens: 200,
        ephemeral_1h_input_tokens: 800,
      },
    };
    const out = normalizeUsage(raw);
    assert.equal(out.cacheCreate5m, 200);
    assert.equal(out.cacheCreate1h, 800);
  });

  it('handles missing optional fields with zero defaults', () => {
    const out = normalizeUsage({ input_tokens: 5, output_tokens: 10 });
    assert.equal(out.cacheRead, 0);
    assert.equal(out.cacheCreate5m, 0);
    assert.equal(out.cacheCreate1h, 0);
    assert.equal(out.webSearches, 0);
    assert.equal(out.webFetches, 0);
  });

  it('returns null when usage object is null/undefined', () => {
    assert.equal(normalizeUsage(null), null);
    assert.equal(normalizeUsage(undefined), null);
  });

  it('reads server_tool_use.web_search_requests and web_fetch_requests', () => {
    const raw = {
      input_tokens: 1,
      output_tokens: 1,
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
    };
    const out = normalizeUsage(raw);
    assert.equal(out.webSearches, 3);
    assert.equal(out.webFetches, 2);
  });
});

describe('costUSD policy — never read pre-computed cost', () => {
  it('does not surface costUSD even when present in input', async () => {
    const turns = await parseSession(SAMPLE);
    for (const t of turns) {
      assert.ok(
        !('costUSD' in t),
        'parser must not surface costUSD; cost is always recomputed'
      );
    }
  });
});

describe('project directory decoding', () => {
  it('decodes path-encoded directory names', () => {
    assert.equal(
      decodeProjectDir('-Users-adnan-Projects-notifyr'),
      '/Users/adnan/Projects/notifyr'
    );
  });

  it('preserves leading slash convention', () => {
    const out = decodeProjectDir('-Users-x');
    assert.ok(out.startsWith('/'));
  });

  it('returns null for empty input', () => {
    assert.equal(decodeProjectDir(''), null);
    assert.equal(decodeProjectDir(null), null);
  });
});

describe('resolveProjectName', () => {
  it('prefers turn.cwd basename when available', () => {
    const turn = { cwd: '/Users/x/Projects/notifyr' };
    assert.equal(resolveProjectName(turn), 'notifyr');
  });

  it('falls back to decoded directory basename', () => {
    assert.equal(
      resolveProjectName(null, '-Users-x-Projects-clauge'),
      'clauge'
    );
  });

  it('returns null when neither source available', () => {
    assert.equal(resolveProjectName(null, null), null);
  });
});
