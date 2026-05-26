#!/usr/bin/env node
// Architecture-guardrail validator (v0.9.7).
//
// For every HTML page in source dirs (popover/, public/), if it loads any
// JS file that references `window.ClaugeBridge` or `ClaugeBridge.*`, the
// HTML MUST also load the bridge-defining file (popover/lib/tauri-bridge.js)
// BEFORE that JS. Otherwise the facade is undefined at runtime and the JS
// silently no-ops (or worse, throws inside a try/catch that swallows it).
//
// Caught by v0.9.5 -> v0.9.6 hotfix incident: popover/splash.html only loaded
// splash.js (which had been migrated to use ClaugeBridge), but never loaded
// lib/tauri-bridge.js. ClaugeBridge was undefined; splash timed out after 30s.
// See AGENT_LEARNINGS.md and AGENTS.md landmine #20 for full context.
//
// Exit 0 on pass, 1 on fail with one line per offending HTML.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.env.CLAUGE_REPO_ROOT || path.resolve(__dirname, '..');

const HTML_SCAN_DIRS = ['popover', 'public'];
const HTML_EXCLUDE_DIRS = ['public/popover', 'node_modules', 'target', 'dist'];

const BRIDGE_DEFINES_RE = /\bwindow\s*\.\s*ClaugeBridge\s*=/;
const BRIDGE_USES_RE = /\bClaugeBridge\b/;

function walk(dir, filter, results) {
  results = results || [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(REPO_ROOT, full);
    if (HTML_EXCLUDE_DIRS.some((ex) => rel === ex || rel.startsWith(ex + path.sep))) continue;
    if (entry.isDirectory()) walk(full, filter, results);
    else if (entry.isFile() && filter(full)) results.push(full);
  }
  return results;
}

function parseScriptSrcs(html) {
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (/^https?:\/\//.test(src)) continue;
    out.push(src);
  }
  return out;
}

function resolveScriptSrc(src, htmlPath) {
  const candidates = [];
  if (src.startsWith('/')) {
    const stripped = src.slice(1);
    if (stripped.startsWith('popover/')) {
      candidates.push(path.join(REPO_ROOT, stripped));
    } else {
      candidates.push(path.join(REPO_ROOT, 'public', stripped));
      candidates.push(path.join(REPO_ROOT, stripped));
    }
  } else {
    candidates.push(path.resolve(path.dirname(htmlPath), src));
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function main() {
  const jsByRole = new Map();
  const jsFiles = walk(REPO_ROOT, (f) => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs'));
  for (const file of jsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    if (BRIDGE_DEFINES_RE.test(content)) jsByRole.set(file, 'defines');
    else if (BRIDGE_USES_RE.test(content)) jsByRole.set(file, 'uses');
  }

  const htmlFiles = [];
  for (const dir of HTML_SCAN_DIRS) {
    const abs = path.join(REPO_ROOT, dir);
    walk(abs, (f) => f.endsWith('.html'), htmlFiles);
  }

  const errors = [];
  for (const htmlPath of htmlFiles) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    const scripts = parseScriptSrcs(html);

    let bridgeIndex = -1;
    const facadeUsers = [];
    scripts.forEach((src, index) => {
      const resolved = resolveScriptSrc(src, htmlPath);
      if (!resolved) return;
      const role = jsByRole.get(resolved);
      if (role === 'defines' && bridgeIndex === -1) bridgeIndex = index;
      if (role === 'uses') facadeUsers.push({ src: src, index: index });
    });

    for (const u of facadeUsers) {
      const relHtml = path.relative(REPO_ROOT, htmlPath);
      if (bridgeIndex === -1) {
        errors.push(relHtml + ': loads "' + u.src + '" which uses ClaugeBridge, but lib/tauri-bridge.js is never loaded in this page.');
      } else if (u.index < bridgeIndex) {
        errors.push(relHtml + ': loads "' + u.src + '" at script position ' + u.index + ', BEFORE the bridge script at position ' + bridgeIndex + '. Bridge must come first (order matters even with defer).');
      }
    }
  }

  if (errors.length === 0) {
    console.log('validate-html-facade-loads: OK');
    process.exit(0);
  }
  console.error('validate-html-facade-loads: FAIL');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

main();
