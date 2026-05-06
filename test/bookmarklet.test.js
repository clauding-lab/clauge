import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkletHref, bookmarkletSource } from '../lib/bookmarklet.js';

describe('bookmarklet', () => {
  it('source includes the configured port', () => {
    const src = bookmarkletSource(3456);
    assert.match(src, /localhost:3456\/api\/usage\/ingest/);
  });

  it('href starts with javascript: and is URL-encoded', () => {
    const href = bookmarkletHref(3456);
    assert.ok(href.startsWith('javascript:'));
    assert.match(href, /%20/); // spaces encoded
  });

  it('different ports produce different bookmarklets', () => {
    assert.notEqual(bookmarkletHref(3456), bookmarkletHref(8080));
  });

  it('source references claude.ai endpoints', () => {
    const src = bookmarkletSource(3456);
    assert.match(src, /\/api\/organizations/);
    assert.match(src, /\/usage/);
  });
});
