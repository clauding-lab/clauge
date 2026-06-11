// Shared fetch-with-timeout for sidecar + CLI outbound HTTP. v1.2.0: collapses
// three bespoke AbortController copies (LiteLLM price fetch, CLI live-config
// GET, CLI provider-toggle POST) into one helper. Plain AbortController (not
// AbortSignal.timeout) keeps semantics identical to the code it replaces.

/**
 * fetch() that aborts after timeoutMs. Throws AbortError on timeout, exactly
 * like the inlined helpers it replaces — callers keep their catch semantics.
 * Any caller-provided init.signal is overridden by the helper's own.
 *
 * @param {string} url
 * @param {object} init  fetch init (may be {})
 * @param {number} timeoutMs
 * @param {typeof fetch} [fetchImpl]  injectable for tests
 */
export async function fetchWithTimeout(url, init, timeoutMs, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
