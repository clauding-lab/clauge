/**
 * JSONL parser for Claude Code session files.
 *
 * Schema verified 2026-05-06 against ~/.claude/projects/*.jsonl. See PRD
 * v3.1 §2.3 for the full field reference. The single most important rule
 * (§2.3.1): assistant API requests emit THREE JSONL lines with identical
 * usage numbers — one per content-block type (thinking / text / tool_use).
 * This parser deduplicates them by requestId so downstream cost math is
 * correct.
 *
 * The dedup + normalization conventions this file relies on (requestId
 * dedup, ephemeral_5m vs ephemeral_1h cache-tier split, never reading
 * costUSD from JSONL) are documented in AGENTS.md
 * "Load-bearing conventions (data contract)". Touch those rules with
 * eyes open — `test/parser.test.js`, `test/cost-calculator.test.js`,
 * and `test/aggregator.test.js` all assume them.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const TURN_TYPES = new Set(['assistant', 'user']);

export function normalizeUsage(rawUsage) {
  if (!rawUsage) return null;
  const cacheCreation = rawUsage.cache_creation ?? {};
  const serverToolUse = rawUsage.server_tool_use ?? {};
  return {
    inputTokens: rawUsage.input_tokens ?? 0,
    outputTokens: rawUsage.output_tokens ?? 0,
    cacheRead: rawUsage.cache_read_input_tokens ?? 0,
    cacheCreate5m: cacheCreation.ephemeral_5m_input_tokens ?? 0,
    cacheCreate1h: cacheCreation.ephemeral_1h_input_tokens ?? 0,
    webSearches: serverToolUse.web_search_requests ?? 0,
    webFetches: serverToolUse.web_fetch_requests ?? 0,
    serviceTier: rawUsage.service_tier ?? null,
  };
}

export async function* streamRecords(filePath) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // Skip malformed lines silently — Claude Code occasionally writes
        // partial lines during force-quit; we don't want one bad line to
        // poison the entire session's analytics.
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

function buildAssistantTurn(record) {
  return {
    type: 'assistant',
    uuid: record.uuid,
    parentUuid: record.parentUuid ?? null,
    sessionId: record.sessionId,
    requestId: record.requestId,
    timestamp: record.timestamp,
    cwd: record.cwd ?? null,
    gitBranch: record.gitBranch ?? null,
    version: record.version ?? null,
    isSidechain: record.isSidechain === true,
    model: record.message?.model ?? null,
    usage: normalizeUsage(record.message?.usage),
    contentBlocks: [],
  };
}

function buildUserTurn(record) {
  return {
    type: 'user',
    uuid: record.uuid,
    parentUuid: record.parentUuid ?? null,
    sessionId: record.sessionId,
    timestamp: record.timestamp,
    cwd: record.cwd ?? null,
    gitBranch: record.gitBranch ?? null,
    version: record.version ?? null,
    message: record.message ?? null,
  };
}

/**
 * Parse a single JSONL file and return turns deduplicated by requestId.
 *
 * @param {string} filePath absolute path to a session JSONL
 * @returns {Promise<Array>} array of turn objects sorted by timestamp
 */
export async function parseSession(filePath) {
  const assistantByRequestId = new Map();
  const userTurns = [];

  for await (const record of streamRecords(filePath)) {
    if (!TURN_TYPES.has(record.type)) continue;

    if (record.type === 'user') {
      userTurns.push(buildUserTurn(record));
      continue;
    }

    // assistant
    const requestId = record.requestId;
    if (!requestId) continue;

    if (!assistantByRequestId.has(requestId)) {
      assistantByRequestId.set(requestId, buildAssistantTurn(record));
    }

    const turn = assistantByRequestId.get(requestId);
    const contentArr = record.message?.content;
    if (Array.isArray(contentArr)) {
      for (const block of contentArr) {
        if (block && block.type) turn.contentBlocks.push(block);
      }
    }
  }

  const turns = [...assistantByRequestId.values(), ...userTurns];
  turns.sort((a, b) =>
    (a.timestamp ?? '').localeCompare(b.timestamp ?? '')
  );
  return turns;
}

/**
 * Decode a path-encoded Claude Code project directory name.
 * Example: "-Users-adnan-Projects-notifyr" → "/Users/adnan/Projects/notifyr"
 *
 * Per PRD v3.1 §2.3, project dirs are path-encoded (slashes → dashes), not
 * hashed. Decoding inverts this. Callers should use the LAST path segment
 * (basename) as the human-readable project name when available.
 */
export function decodeProjectDir(encodedName) {
  if (!encodedName) return null;
  const path = encodedName.replace(/-/g, '/');
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Resolve human-readable project name from a turn record.
 *
 * Preference order: turn.cwd basename → decoded directory basename → null.
 */
export function resolveProjectName(turn, encodedDirName) {
  if (turn?.cwd) {
    const segs = turn.cwd.split('/').filter(Boolean);
    return segs[segs.length - 1] ?? null;
  }
  if (encodedDirName) {
    const decoded = decodeProjectDir(encodedDirName);
    const segs = decoded.split('/').filter(Boolean);
    return segs[segs.length - 1] ?? null;
  }
  return null;
}
