#!/usr/bin/env node
// Architecture-guardrail validator (v0.9.7, extended v0.9.8).
//
// For every HTML page in source dirs (popover/, public/), and for every
// known facade (ClaugeBridge, t()-copy.js), if the page loads a JS file
// that references the facade, the page MUST also load the facade-defining
// file BEFORE that JS. Otherwise the facade is undefined at runtime and the
// JS silently no-ops (or worse, throws inside a try/catch that swallows it).
//
// Caught by two real incidents:
//   - v0.9.5 -> v0.9.6 hotfix: popover/splash.html only loaded splash.js
//     (which had been migrated to use ClaugeBridge), but never loaded
//     lib/tauri-bridge.js. ClaugeBridge was undefined; splash timed out
//     after 30s. (Facade: ClaugeBridge.)
//   - v0.9.7 -> v0.9.8 hotfix: public/index.html (dashboard) loaded
//     /popover/heatmap.js (which uses t() per cell for tooltip strings)
//     but never loaded /popover/lib/copy.js. window.t was undefined;
//     defaultTooltip threw ReferenceError on the first non-empty cell;
//     the activity heatmap stayed blank. (Facade: t() from copy.js.)
//
// See AGENT_LEARNINGS.md and AGENTS.md landmine #20 for full context.
//
// Exit 0 on pass, 1 on fail with one line per offending HTML.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.env.CLAUGE_REPO_ROOT || path.resolve(__dirname, '..');

const HTML_SCAN_DIRS = ['popover', 'public'];
const HTML_EXCLUDE_DIRS = ['public/popover', 'node_modules', 'target', 'dist'];

// Each facade is independent — a single HTML page can violate one without
// the other. Order in this list controls the order of error reporting.
const FACADES = [
  {
    name: 'ClaugeBridge',
    definesRe: /\bwindow\s*\.\s*ClaugeBridge\s*=/,
    usesRe: /\bClaugeBridge\b/,
    definerLabel: 'lib/tauri-bridge.js',
  },
  {
    name: 't() (copy.js registry)',
    definesRe: /\bwindow\s*\.\s*t\s*=/,
    // String-literal key disambiguates from setTimeout / parseInt / etc.
    usesRe: /\bt\s*\(\s*['"][\w.]+['"]/,
    definerLabel: 'lib/copy.js',
  },
];

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

// Classify a JS file against ALL facades. A file can define one facade and
// use another (e.g., a helper that defines window.foo AND calls
// ClaugeBridge.bar()).
function classifyJs(content) {
  const roles = new Map();
  for (const f of FACADES) {
    if (f.definesRe.test(content)) roles.set(f.name, 'defines');
    else if (f.usesRe.test(content)) roles.set(f.name, 'uses');
  }
  return roles;
}

function main() {
  const jsRoles = new Map();
  const jsFiles = walk(REPO_ROOT, (f) => f.endsWith('.js') || f.endsWith('.cjs') || f.endsWith('.mjs'));
  for (const file of jsFiles) {
    const content = fs.readFileSync(file, 'utf8');
    jsRoles.set(file, classifyJs(content));
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
    const relHtml = path.relative(REPO_ROOT, htmlPath);

    for (const facade of FACADES) {
      let defIndex = -1;
      const users = [];
      scripts.forEach((src, index) => {
        const resolved = resolveScriptSrc(src, htmlPath);
        if (!resolved) return;
        const role = (jsRoles.get(resolved) || new Map()).get(facade.name);
        if (role === 'defines' && defIndex === -1) defIndex = index;
        if (role === 'uses') users.push({ src, index });
      });

      for (const u of users) {
        if (defIndex === -1) {
          errors.push(
            relHtml + ': loads "' + u.src + '" which uses ' + facade.name
              + ', but ' + facade.definerLabel + ' is never loaded in this page.',
          );
        } else if (u.index < defIndex) {
          errors.push(
            relHtml + ': loads "' + u.src + '" at script position ' + u.index
              + ', BEFORE the ' + facade.name + ' definer at position ' + defIndex
              + '. Definer (' + facade.definerLabel + ') must come first (order matters even with defer).',
          );
        }
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
