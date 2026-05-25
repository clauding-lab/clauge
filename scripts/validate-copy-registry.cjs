#!/usr/bin/env node
// Architecture guardrail (v0.9.4 Phase B.1).
//
// Validates `popover/copy.json` is well-formed and that every t('key.path')
// call in popover/*.js resolves to a real entry. Catches:
//   - Missing keys (typo in t('session.elaspedOf5h'))
//   - Stale keys (deleted from copy.json but still referenced)
//   - Malformed copy.json (parse failure)
//
// This is the LIGHT-touch version of the v0.9.4 plan's B.1: full string
// extraction is still in progress. The validator currently only enforces
// "every t() call resolves" — it does NOT yet flag hardcoded user-facing
// strings in popover.js / heatmap.js (string extraction proceeds across
// follow-up commits; once complete, this script grows a "no raw strings"
// pass too).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.env.CLAUGE_REPO_ROOT
  ? path.resolve(process.env.CLAUGE_REPO_ROOT)
  : path.resolve(__dirname, '..');
const COPY_JSON_PATH = path.join(REPO_ROOT, 'popover', 'copy.json');
const SCAN_DIRS = ['popover'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p, out);
    } else if (/\.(js|cjs|mjs|html)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

function loadCopy() {
  let raw;
  try {
    raw = fs.readFileSync(COPY_JSON_PATH, 'utf8');
  } catch (e) {
    console.error('[validate-copy-registry] FAIL - cannot read copy.json:', e.message);
    process.exit(1);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.error('[validate-copy-registry] FAIL - copy.json is not valid JSON:', e.message);
    process.exit(1);
  }
  return obj;
}

function flatten(obj, prefix = '') {
  const keys = new Set();
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') keys.add(path);
    else if (v && typeof v === 'object') {
      for (const sub of flatten(v, path)) keys.add(sub);
    }
  }
  return keys;
}

function collectReferencedKeys(files) {
  const refs = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const pattern = /\bt\s*\(\s*['"]([^'"]+)['"]/g;
    for (const m of src.matchAll(pattern)) {
      const key = m[1];
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key).push(path.relative(REPO_ROOT, f));
    }
  }
  return refs;
}

function main() {
  const copy = loadCopy();
  const definedKeys = flatten(copy);

  const files = [];
  for (const d of SCAN_DIRS) files.push(...walk(path.join(REPO_ROOT, d)));
  const refs = collectReferencedKeys(files);

  const errors = [];

  for (const [key, locations] of refs) {
    if (!definedKeys.has(key)) {
      errors.push(`t('${key}') referenced in ${locations[0]} but not in copy.json`);
    }
  }

  if (errors.length > 0) {
    console.error('[validate-copy-registry] FAIL - copy registry drift:\n');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }

  process.stdout.write(
    `[validate-copy-registry] OK - ${definedKeys.size} keys defined, ${refs.size} unique t() references resolve\n`,
  );
}

main();
