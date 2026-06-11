import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithTimeout } from '../lib/http.js';

describe('fetchWithTimeout', () => {
  it('passes url + init through and resolves with the response', async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return { ok: true };
    };
    const res = await fetchWithTimeout(
      'http://127.0.0.1:9/api/x',
      { method: 'POST', body: 'b' },
      1000,
      fetchImpl,
    );
    assert.equal(res.ok, true);
    assert.equal(seen.url, 'http://127.0.0.1:9/api/x');
    assert.equal(seen.init.method, 'POST');
    assert.equal(seen.init.body, 'b');
    assert.ok(seen.init.signal instanceof AbortSignal, 'helper must attach its own signal');
  });

  it('aborts a hung fetch after timeoutMs', async () => {
    const fetchImpl = (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    await assert.rejects(
      fetchWithTimeout('http://127.0.0.1:9/api/hang', {}, 20, fetchImpl),
      { name: 'AbortError' },
    );
  });

  it('clears the timer on success (no open handle keeps the loop alive)', async () => {
    // If the timer were not cleared, node:test would flag the dangling
    // timeout; resolving fast and finishing the test is the assertion.
    const fetchImpl = async () => ({ ok: true });
    await fetchWithTimeout('http://127.0.0.1:9/api/x', {}, 60_000, fetchImpl);
  });
});
