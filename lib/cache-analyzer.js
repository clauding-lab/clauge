/**
 * Cache analytics per PRD v3.1 §2.4.
 *
 * Hit rate (CORRECTED — denominator includes cache_creation):
 *   cache_read / (cache_read + cache_create_5m + cache_create_1h + input_tokens)
 *
 * Net savings (CORRECTED — accounts for write overhead):
 *   savings = read_savings - write_overhead_5m - write_overhead_1h
 *   read_savings        = cache_read   × (input_rate − cache_read_rate)
 *   write_overhead_5m   = cache_5m     × (cache_5m_rate − input_rate)
 *   write_overhead_1h   = cache_1h     × (cache_1h_rate − input_rate)
 *
 * Cache writes cost more than uncached input ($3.75/1M vs $3.00/1M for
 * Anthropic). A write-heavy session with few reads can produce negative
 * savings — that is correct, not a bug.
 */

/**
 * Compute cache hit rate for one normalized usage object (or aggregate).
 * Returns null if there is no input-side activity at all.
 */
export function cacheHitRate(usage) {
  if (!usage) return null;
  const read = usage.cacheRead ?? 0;
  const c5 = usage.cacheCreate5m ?? 0;
  const c1 = usage.cacheCreate1h ?? 0;
  const inp = usage.inputTokens ?? 0;
  const denom = read + c5 + c1 + inp;
  if (denom === 0) return null;
  return read / denom;
}

/**
 * Net cache savings in dollars for one usage row, given the model's
 * resolved per-token rates (LiteLLM shape).
 *
 * Returns 0 (not null) when there is no cache activity — additive in sums.
 */
export function netCacheSavings(usage, rates) {
  if (!usage || !rates) return 0;
  const read = usage.cacheRead ?? 0;
  const c5 = usage.cacheCreate5m ?? 0;
  const c1 = usage.cacheCreate1h ?? 0;

  const inputRate = rates.input_cost_per_token ?? 0;
  const readRate = rates.cache_read_input_token_cost ?? 0;
  const c5Rate = rates.cache_creation_input_token_cost ?? 0;
  const c1Rate =
    rates.cache_creation_input_token_cost_above_1hr ??
    rates.cache_creation_input_token_cost ??
    0;

  const readSavings = read * (inputRate - readRate);
  const c5Overhead = c5 * (c5Rate - inputRate);
  const c1Overhead = c1 * (c1Rate - inputRate);

  return readSavings - c5Overhead - c1Overhead;
}

/**
 * Aggregate usage across many turns into a single object suitable for
 * cacheHitRate / netCacheSavings.
 */
export function aggregateUsage(turns) {
  const init = {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    webSearches: 0,
    webFetches: 0,
  };
  if (!Array.isArray(turns)) return init;
  return turns.reduce((acc, t) => {
    const u = t.usage ?? {};
    acc.inputTokens += u.inputTokens ?? 0;
    acc.outputTokens += u.outputTokens ?? 0;
    acc.cacheRead += u.cacheRead ?? 0;
    acc.cacheCreate5m += u.cacheCreate5m ?? 0;
    acc.cacheCreate1h += u.cacheCreate1h ?? 0;
    acc.webSearches += u.webSearches ?? 0;
    acc.webFetches += u.webFetches ?? 0;
    return acc;
  }, init);
}
