/**
 * Cost calculation per PRD v3.1 §2.6.
 *
 * Pricing source priority:
 *   1. ~/.cache/clauge/litellm-prices.json (24h-fresh)
 *   2. https://raw.githubusercontent.com/.../model_prices_and_context_window.json
 *   3. Bundled lib/litellm-prices.fallback.json (offline-safe)
 *   4. Per-1M-token .env overrides for missing models
 *
 * NEVER reads `costUSD` from JSONL. Cost is always recomputed from token
 * counts × current rate so rate-preset switching propagates to history.
 *
 * LiteLLM rates are PER TOKEN (e.g., 0.000005). .env rates are
 * PER 1M TOKENS (Anthropic doc convention) and divided by 1e6 internally.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout } from './http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const FALLBACK_PATH = join(__dirname, 'litellm-prices.fallback.json');

function defaultCachePath() {
  return join(homedir(), '.cache', 'clauge', 'litellm-prices.json');
}

async function readJson(path) {
  const buf = await readFile(path, 'utf8');
  return JSON.parse(buf);
}

async function readFresh(path) {
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs > CACHE_TTL_MS) return null;
    return await readJson(path);
  } catch {
    return null;
  }
}

async function fetchLiteLLM(url, timeoutMs) {
  const res = await fetchWithTimeout(url, {}, timeoutMs);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/**
 * Load the price table from the freshest available source.
 *
 * @returns {Promise<{source, fetchedAt, prices}>}
 */
export async function loadPriceTable({
  cachePath = defaultCachePath(),
  fallbackPath = FALLBACK_PATH,
  url = LITELLM_URL,
  forceFresh = false,
} = {}) {
  if (!forceFresh) {
    const cached = await readFresh(cachePath);
    if (cached) {
      return { source: 'cache', fetchedAt: null, prices: cached };
    }
  }

  try {
    const fresh = await fetchLiteLLM(url, FETCH_TIMEOUT_MS);
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(fresh));
    } catch {
      // Non-fatal: cache write failure shouldn't break the request.
    }
    return { source: 'fetch', fetchedAt: new Date().toISOString(), prices: fresh };
  } catch {
    const bundled = await readJson(fallbackPath);
    return { source: 'fallback', fetchedAt: null, prices: bundled };
  }
}

/**
 * Convert a per-1M-token .env rate to a per-token rate.
 */
function per1MToPerToken(rateOrUndef) {
  if (rateOrUndef == null) return null;
  const n = Number(rateOrUndef);
  if (!Number.isFinite(n)) return null;
  return n / 1_000_000;
}

/**
 * Build a normalized model-rate object from .env-style overrides.
 */
export function envFallbackRates(env = process.env) {
  return {
    input_cost_per_token: per1MToPerToken(env.RATE_INPUT) ?? 0,
    output_cost_per_token: per1MToPerToken(env.RATE_OUTPUT) ?? 0,
    cache_read_input_token_cost: per1MToPerToken(env.RATE_CACHE_READ) ?? 0,
    cache_creation_input_token_cost: per1MToPerToken(env.RATE_CACHE_CREATE) ?? 0,
    cache_creation_input_token_cost_above_1hr:
      per1MToPerToken(env.RATE_CACHE_CREATE_1H) ??
      per1MToPerToken(env.RATE_CACHE_CREATE) ??
      0,
    search_context_cost_per_query: { search_context_size_medium: 0 },
  };
}

function ratesForModel(model, prices, envFallback) {
  const direct = model && prices?.[model];
  if (direct) return { rates: direct, source: 'litellm' };
  return { rates: envFallback, source: 'env-fallback' };
}

/**
 * Compute the cost of a single deduplicated assistant turn.
 *
 * @param usage normalized usage from parser.normalizeUsage
 * @param model e.g. "claude-opus-4-7"
 * @param priceTable result.prices from loadPriceTable
 * @param envFallback rates object for unknown models
 * @returns {{total, breakdown, source, model}}
 */
export function costForTurn(usage, model, priceTable, envFallback) {
  if (!usage) {
    return {
      total: 0,
      breakdown: { input: 0, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0, search: 0 },
      source: 'no-usage',
      model: model ?? null,
    };
  }
  const { rates, source } = ratesForModel(model, priceTable, envFallback);

  const inputRate = rates.input_cost_per_token ?? 0;
  const outputRate = rates.output_cost_per_token ?? 0;
  const cacheReadRate = rates.cache_read_input_token_cost ?? 0;
  const cache5mRate = rates.cache_creation_input_token_cost ?? 0;
  const cache1hRate =
    rates.cache_creation_input_token_cost_above_1hr ??
    rates.cache_creation_input_token_cost ??
    0;
  const searchRate =
    rates.search_context_cost_per_query?.search_context_size_medium ?? 0;

  const input = (usage.inputTokens ?? 0) * inputRate;
  const output = (usage.outputTokens ?? 0) * outputRate;
  const cacheRead = (usage.cacheRead ?? 0) * cacheReadRate;
  const cache5m = (usage.cacheCreate5m ?? 0) * cache5mRate;
  const cache1h = (usage.cacheCreate1h ?? 0) * cache1hRate;
  const search = ((usage.webSearches ?? 0) + (usage.webFetches ?? 0)) * searchRate;

  const total = input + output + cacheRead + cache5m + cache1h + search;

  return {
    total,
    breakdown: { input, output, cacheRead, cache5m, cache1h, search },
    source,
    model: model ?? null,
  };
}

/**
 * Resolve per-model rates for downstream use (e.g., cache-analyzer needs
 * the same rates the cost calculator would have used).
 */
export function resolveModelRates(model, priceTable, envFallback) {
  return ratesForModel(model, priceTable, envFallback).rates;
}
