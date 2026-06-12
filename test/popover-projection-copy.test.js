import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Contract test for the popover projection display (sub-project A, PR 3).
// popover.js is a classic browser script with no vm seam (only
// popover/lib/swr.js has one — test/popover-swr.test.js), so the render
// logic itself is covered by the projection fixtures + manual smoke. What
// CAN be locked down headlessly is the display contract: the copy registry
// templates (exact strings, exact {param} names the t() calls rely on) and
// the hero-gauge mount points the renderer writes into.

const ROOT = join(import.meta.dirname, '..');
const copy = JSON.parse(readFileSync(join(ROOT, 'popover', 'copy.json'), 'utf8'));
const indexHtml = readFileSync(join(ROOT, 'popover', 'index.html'), 'utf8');

test('copy.json defines the four projection strings with exact templates', () => {
  assert.deepEqual(copy.projection, {
    willHit: 'At this pace → 100% ~{time}',
    safe: 'On pace to end at ~{pct}%',
    exhausted: 'Limit reached — resets {time}',
    wow: '{delta} pts vs last week',
  });
});

test('popover index.html mounts the forecast lines under both hero gauges', () => {
  for (const id of ['session-forecast', 'weekly-forecast', 'weekly-wow']) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `missing #${id} in popover/index.html`);
  }
});
