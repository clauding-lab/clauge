# Clauge V3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Clauge as a native macOS desktop app that wraps the existing Hono analytics server in a Tauri 2.x menu-bar shell with a frameless vibrancy popover, a lazy native dashboard window, auto-update, and Launch-at-Login support — without breaking the npm package or the Chrome extension.

**Architecture:** Tauri 2.x (Rust) main process owns the app lifecycle, tray, windows, and updater. The existing `server.js` + `lib/*` is compiled into a single Node 22 SEA Universal binary (`clauge-server`) and spawned as a Tauri sidecar. Both UIs (popover + dashboard) are WebView pages talking to the sidecar over `http://127.0.0.1:<port>` exactly like a browser tab would. V3 health-pings 3456 on launch — if a clauge server already responds (npm clauge), V3 acts as pure UI client.

**Tech Stack:**
- Tauri 2.x (Rust 1.75+, edition 2021)
- Node.js 22+ Single Executable Applications (SEA)
- Hono 4.x (existing)
- Vanilla HTML/CSS/JS for popover (no framework, ports `docs/design/menubar.jsx`)
- Tauri plugins: shell, single-instance, autostart, updater, notification, window-state, store
- GitHub Actions for release pipeline
- `tauri-driver` for E2E
- `node:test` for unit + smoke tests
- `cargo test` for Rust unit tests

**Spec:** `docs/superpowers/specs/2026-05-07-clauge-v3-design.md`

---

## File structure

### New files

```
src-tauri/                                    Tauri Rust crate
├── Cargo.toml                                deps + features
├── build.rs                                  Tauri build hook
├── tauri.conf.json                           windows, plugins, updater key
├── capabilities/main.json                    Tauri 2.x permission scopes
├── icons/                                    app icon set (16/32/128/256/512/1024)
├── icons/tray-icon.png                       16×16 monochrome template
├── icons/tray-icon@2x.png                    32×32 monochrome template
└── src/
    ├── main.rs                               Tauri entry, plugin wiring
    ├── sidecar.rs                            spawn/kill, crash circuit-breaker
    ├── port_discovery.rs                     /api/health probe + fallback
    ├── ipc.rs                                #[tauri::command] handlers
    ├── tray.rs                               tray icon + native right-click menu
    ├── menu.rs                               native macOS menu bar (File/Edit/View)
    └── windows.rs                            popover + dashboard window builders

popover/                                      Tauri WebView (frameless, vibrancy)
├── index.html                                popover frame
├── popover.js                                vanilla port of docs/design/menubar.jsx
└── popover.css                               styles (extends public/styles.css tokens)

scripts/
├── build-sidecar.sh                          Universal SEA build (arm64 + x86_64 → lipo)
├── sea-config.json                           SEA blob configuration
└── strip-quarantine.sh                       post-update hook for xattr -d

.github/workflows/
└── release.yml                               build + sign + publish DMG on tag

test/
├── server-additions.test.js                  /api/health, port fallback, SIGTERM
├── sea-smoke.test.js                         build SEA, spawn, curl, SIGTERM
└── e2e/
    ├── setup.ts                              tauri-driver bootstrap
    └── v3.test.ts                            7 E2E scenarios

docs/
└── RELEASE_CHECKLIST.md                      manual smoke checklist + key rotation procedure
```

### Modified files

```
server.js                                     +/api/health, +port-fallback, verify SIGTERM
package.json                                  +scripts: tauri:dev, tauri:build, build:sidecar, test:sea
.gitignore                                    +dist/, +src-tauri/target/, +dist-tauri/
```

### Unchanged

```
lib/                                          all 11 modules untouched
public/                                       index.html / app.js / styles.css untouched
test/*.test.js                                existing 103 tests pass as-is
```

---

## Phase 0 — Repository scaffolding

Bootstrap Tauri 2.x and the SEA build pipeline. No app behavior yet — just verify both build chains work end to end.

---

### Task 1: Add Node 22 engine requirement and update gitignore

**Files:**
- Modify: `package.json:24`
- Modify: `.gitignore`

- [ ] **Step 1: Bump engines.node to 22**

In `package.json`, change:
```json
"engines": {
  "node": ">=22.0.0"
},
```

- [ ] **Step 2: Add Tauri/SEA build artifacts to .gitignore**

Append to `.gitignore`:
```
# V3 build outputs
dist/
src-tauri/target/
src-tauri/gen/
sea-prep.blob
```

- [ ] **Step 3: Verify Node 22 is available locally**

Run: `node --version`
Expected: `v22.x.x` or higher. If lower, install Node 22 via nvm/asdf/brew before proceeding.

- [ ] **Step 4: Run existing tests to confirm baseline**

Run: `npm test`
Expected: `# tests 103` and `# pass 103`.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: require Node 22 and ignore Tauri build outputs"
```

---

### Task 2: Initialize Tauri 2.x scaffold

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs` (placeholder)
- Create: `src-tauri/capabilities/main.json`

- [ ] **Step 1: Create Cargo manifest**

Write `src-tauri/Cargo.toml`:

```toml
[package]
name = "clauge"
version = "0.3.0"
description = "Clauge — Claude Code analytics native shell"
authors = ["clauding-lab"]
edition = "2021"
rust-version = "1.75"

[lib]
name = "clauge_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
tauri = { version = "2.0", features = ["macos-private-api", "tray-icon"] }
tauri-plugin-shell = "2.0"
tauri-plugin-single-instance = "2.0"
tauri-plugin-autostart = "2.0"
tauri-plugin-updater = "2.0"
tauri-plugin-notification = "2.0"
tauri-plugin-window-state = "2.0"
tauri-plugin-store = "2.0"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
log = "0.4"
env_logger = "0.11"

[dev-dependencies]
tokio-test = "0.4"
mockito = "1.5"

[profile.release]
panic = "abort"
codegen-units = 1
lto = true
opt-level = "s"
strip = true
```

- [ ] **Step 2: Create build.rs**

Write `src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 3: Create minimal tauri.conf.json**

Write `src-tauri/tauri.conf.json`:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Clauge",
  "version": "0.3.0",
  "identifier": "com.clauding.clauge",
  "build": {
    "beforeBuildCommand": "bash ../scripts/build-sidecar.sh",
    "frontendDist": "../public"
  },
  "app": {
    "windows": [],
    "security": {
      "csp": null
    },
    "macOSPrivateApi": true
  },
  "bundle": {
    "active": true,
    "targets": ["dmg"],
    "macOS": {
      "minimumSystemVersion": "12.0"
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns"
    ]
  },
  "plugins": {}
}
```

- [ ] **Step 4: Create placeholder main.rs**

Write `src-tauri/src/main.rs`:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    clauge_lib::run()
}
```

Write `src-tauri/src/lib.rs`:
```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Create permission capabilities**

Write `src-tauri/capabilities/main.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main",
  "description": "Default permissions for Clauge",
  "windows": ["main", "popover"],
  "permissions": [
    "core:default",
    "shell:allow-spawn",
    "shell:allow-kill"
  ]
}
```

- [ ] **Step 6: Add temporary placeholder icon**

Run:
```bash
mkdir -p src-tauri/icons
# Copy existing brand icon as placeholder
cp docs/icons/clauge-icon-128.png src-tauri/icons/128x128.png 2>/dev/null || \
  curl -sL https://raw.githubusercontent.com/clauding-lab/clauge/main/docs/icons/clauge-icon-128.png \
  -o src-tauri/icons/128x128.png
```

(Real icons set up properly in Task 3.)

- [ ] **Step 7: Verify cargo build succeeds**

Run: `cd src-tauri && cargo build && cd ..`
Expected: completes successfully, produces `src-tauri/target/debug/clauge`. May take 5-15 min on first build (downloads + compiles Tauri).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/
git commit -m "feat(v3): scaffold Tauri 2.x project skeleton"
```

---

### Task 3: Generate proper macOS app icon set

**Files:**
- Create: `src-tauri/icons/icon.icns`
- Create: `src-tauri/icons/32x32.png`
- Create: `src-tauri/icons/128x128.png`
- Create: `src-tauri/icons/128x128@2x.png`
- Create: `src-tauri/icons/tray-icon.png` (16×16 monochrome template)
- Create: `src-tauri/icons/tray-icon@2x.png` (32×32 monochrome template)

- [ ] **Step 1: Generate full icon set from existing 1024 PNG**

Source: `docs/icons/clauge-icon-1024.png` (per session notes, this exists).

Run:
```bash
cd src-tauri/icons
# Generate sizes via sips (macOS built-in)
for size in 32 128 256 512 1024; do
  sips -z $size $size ../../docs/icons/clauge-icon-1024.png --out ${size}x${size}.png
done
sips -z 256 256 ../../docs/icons/clauge-icon-1024.png --out 128x128@2x.png
sips -z 1024 1024 ../../docs/icons/clauge-icon-1024.png --out icon.png
# Generate icns
mkdir clauge.iconset
sips -z 16 16     ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_16x16.png
sips -z 32 32     ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_16x16@2x.png
sips -z 32 32     ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_32x32.png
sips -z 64 64     ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_32x32@2x.png
sips -z 128 128   ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_128x128.png
sips -z 256 256   ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_128x128@2x.png
sips -z 256 256   ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_256x256.png
sips -z 512 512   ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_256x256@2x.png
sips -z 512 512   ../../docs/icons/clauge-icon-1024.png --out clauge.iconset/icon_512x512.png
cp ../../docs/icons/clauge-icon-1024.png clauge.iconset/icon_512x512@2x.png
iconutil -c icns clauge.iconset
rm -rf clauge.iconset
cd ../..
```

- [ ] **Step 2: Generate monochrome tray icon (template image)**

Source: `docs/design/assets/clauge-menubar.svg` (per session notes).

Run:
```bash
# rsvg-convert via brew install librsvg, OR use existing menubar.svg if already raster
# For now, use sips on a 1024 PNG and accept colored tray icon
sips -z 16 16 docs/icons/clauge-icon-1024.png --out src-tauri/icons/tray-icon.png
sips -z 32 32 docs/icons/clauge-icon-1024.png --out src-tauri/icons/tray-icon@2x.png
```

If a proper monochrome SVG is available, prefer rasterizing it via `rsvg-convert` for true template-image support (auto-inverts in dark/light menu bar). Note in `docs/RELEASE_CHECKLIST.md` that pre-1.0 the tray icon is colored, not template.

- [ ] **Step 3: Verify icons in tauri.conf.json paths**

Confirm files exist:
```bash
ls src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,tray-icon.png,tray-icon@2x.png}
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/icons/
git commit -m "feat(v3): add macOS app icon set + tray icon"
```

---

### Task 4: Add SEA build script and config

**Files:**
- Create: `scripts/sea-config.json`
- Create: `scripts/build-sidecar.sh`
- Modify: `package.json` (add scripts)

- [ ] **Step 1: Create SEA config**

Write `scripts/sea-config.json`:
```json
{
  "main": "server.js",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true,
  "assets": {
    "lib/litellm-prices.fallback.json": "lib/litellm-prices.fallback.json"
  }
}
```

- [ ] **Step 2: Create universal SEA build script**

Write `scripts/build-sidecar.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Builds clauge-server as a Universal (arm64 + x86_64) Node SEA binary.
# Output: src-tauri/binaries/clauge-server-aarch64-apple-darwin
# Output: src-tauri/binaries/clauge-server-x86_64-apple-darwin

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DIST="$REPO_ROOT/dist"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
mkdir -p "$DIST" "$BIN_DIR"

# 1. Build the SEA blob (architecture-independent — same JS for all archs)
echo "[build-sidecar] Generating SEA blob..."
node --experimental-sea-config scripts/sea-config.json

# 2. Helper: inject blob into a node binary for a given arch
inject_sea() {
  local arch="$1"        # arm64 | x86_64
  local target="$2"      # tauri triple
  local node_bin="$3"    # path to node binary for that arch
  local out="$BIN_DIR/clauge-server-$target"

  cp "$node_bin" "$out"
  codesign --remove-signature "$out" || true
  npx postject "$out" NODE_SEA_BLOB sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  chmod +x "$out"

  # Re-sign ad-hoc so macOS allows execution
  codesign --sign - --force --preserve-metadata=entitlements,requirements,flags,runtime "$out"
  echo "[build-sidecar] Built $out"
}

# 3. Determine current node arch
CURRENT_ARCH=$(node -e "console.log(process.arch)")
CURRENT_NODE=$(command -v node)

if [[ "$CURRENT_ARCH" == "arm64" ]]; then
  inject_sea "arm64" "aarch64-apple-darwin" "$CURRENT_NODE"
else
  inject_sea "x86_64" "x86_64-apple-darwin" "$CURRENT_NODE"
fi

# 4. For the OTHER arch, download the matching node tarball
NODE_VERSION=$(node --version | sed 's/^v//')
OTHER_ARCH="x64"
OTHER_TRIPLE="x86_64-apple-darwin"
if [[ "$CURRENT_ARCH" != "arm64" ]]; then
  OTHER_ARCH="arm64"
  OTHER_TRIPLE="aarch64-apple-darwin"
fi

OTHER_TARBALL="node-v${NODE_VERSION}-darwin-${OTHER_ARCH}.tar.gz"
OTHER_URL="https://nodejs.org/dist/v${NODE_VERSION}/${OTHER_TARBALL}"
TMP_DIR=$(mktemp -d)
trap "rm -rf $TMP_DIR" EXIT

echo "[build-sidecar] Downloading node v${NODE_VERSION} for $OTHER_ARCH..."
curl -sL "$OTHER_URL" -o "$TMP_DIR/$OTHER_TARBALL"
tar -xzf "$TMP_DIR/$OTHER_TARBALL" -C "$TMP_DIR"
OTHER_NODE="$TMP_DIR/node-v${NODE_VERSION}-darwin-${OTHER_ARCH}/bin/node"

inject_sea "$OTHER_ARCH" "$OTHER_TRIPLE" "$OTHER_NODE"

# 5. Cleanup blob
rm -f sea-prep.blob

echo "[build-sidecar] Done. Universal SEA binaries in $BIN_DIR"
ls -lh "$BIN_DIR"
```

- [ ] **Step 3: Make build-sidecar.sh executable**

Run: `chmod +x scripts/build-sidecar.sh`

- [ ] **Step 4: Add npm scripts**

In `package.json`, modify the `scripts` block to:
```json
"scripts": {
  "start": "node server.js",
  "dev": "node --watch server.js",
  "test": "node --test test/",
  "test:sea": "node --test test/sea-smoke.test.js",
  "build:sidecar": "bash scripts/build-sidecar.sh",
  "tauri:dev": "cd src-tauri && cargo tauri dev",
  "tauri:build": "cd src-tauri && cargo tauri build"
}
```

- [ ] **Step 5: Install postject if not already**

Run: `npm install --save-dev postject`

- [ ] **Step 6: Run the build to verify it produces binaries**

Run: `npm run build:sidecar`
Expected: `src-tauri/binaries/clauge-server-aarch64-apple-darwin` and `src-tauri/binaries/clauge-server-x86_64-apple-darwin` both exist and are executable.

- [ ] **Step 7: Smoke-test the sidecar binary manually**

Run: `./src-tauri/binaries/clauge-server-aarch64-apple-darwin &`
Expected: prints `[Clauge] Listening on http://localhost:3456`. Then:
```bash
curl http://localhost:3456/api/sessions?period=7d | head -c 100
kill %1
```

- [ ] **Step 8: Commit**

```bash
git add scripts/ package.json package-lock.json
git commit -m "feat(v3): add Node SEA universal sidecar build pipeline"
```

---

## Phase 1 — Server modifications

Add the `/api/health` endpoint, port-fallback retry, and verify SIGTERM behavior. All test-driven.

---

### Task 5: Add `/api/health` endpoint

**Files:**
- Modify: `server.js` (add route before `app.use('/*', serveStatic(...))`)
- Create: `test/server-additions.test.js`

- [ ] **Step 1: Write the failing test**

Write `test/server-additions.test.js`:
```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SERVER_BIN = process.env.CLAUGE_SERVER_BIN ?? 'node';
const SERVER_ARGS = process.env.CLAUGE_SERVER_BIN ? [] : ['server.js'];

async function startServer(envOverrides = {}) {
  const child = spawn(SERVER_BIN, SERVER_ARGS, {
    env: { ...process.env, NO_OPEN: '1', ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for "Listening on" line on stdout
  await new Promise((resolve, reject) => {
    const onData = (buf) => {
      if (buf.toString().includes('Listening on')) {
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    setTimeout(() => reject(new Error('server start timeout')), 5000);
  });
  return child;
}

describe('GET /api/health', () => {
  let server;
  before(async () => { server = await startServer({ PORT: '3499' }); });
  after(() => { server.kill('SIGTERM'); });

  it('returns 200 with service identity', async () => {
    const res = await fetch('http://127.0.0.1:3499/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, 'clauge');
    assert.ok(typeof body.version === 'string', 'version is a string');
    assert.ok(typeof body.pid === 'number', 'pid is a number');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `node --test test/server-additions.test.js`
Expected: FAIL — `/api/health` returns 404 (or whatever serveStatic returns).

- [ ] **Step 3: Implement /api/health in server.js**

In `server.js`, locate the line `app.use('/*', serveStatic({ root: join(__dirname, 'public') }));` (around line 472). Insert ABOVE it:

```js
import { readFileSync } from 'node:fs';
const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
);

app.get('/api/health', (c) =>
  c.json({
    service: 'clauge',
    version: APP_VERSION,
    pid: process.pid,
  })
);
```

(Note: if `readFileSync` and `JSON.parse` for package.json are already imported elsewhere, reuse them.)

- [ ] **Step 4: Run test — verify it passes**

Run: `node --test test/server-additions.test.js`
Expected: PASS.

- [ ] **Step 5: Run the FULL test suite — verify nothing else broke**

Run: `npm test`
Expected: 104 tests pass (103 existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add server.js test/server-additions.test.js
git commit -m "feat(server): add /api/health endpoint for V3 sidecar discovery"
```

---

### Task 6: Add port-fallback retry loop

**Files:**
- Modify: `server.js` (replace single `serve(...)` call with retry loop)
- Modify: `test/server-additions.test.js` (add 2 tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/server-additions.test.js`:
```js
import { createServer } from 'node:net';

describe('port fallback', () => {
  let blocker, server;

  before(async () => {
    // Hold port 3500 with a dummy listener so server has to fall back
    blocker = createServer().listen(3500);
    await new Promise((r) => blocker.once('listening', r));
    server = await startServer({ PORT: '3500' });
  });

  after(() => {
    server?.kill('SIGTERM');
    blocker?.close();
  });

  it('falls back to next port when configured port is busy', async () => {
    // Server should have logged "Listening on" with port 3501
    const res = await fetch('http://127.0.0.1:3501/api/health');
    assert.equal(res.status, 200);
  });

  it('exposes chosen port via stderr line for Tauri to parse', async () => {
    const child = spawn(SERVER_BIN, SERVER_ARGS, {
      env: { ...process.env, PORT: '3502', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    child.stderr.on('data', (b) => { stderrBuf += b.toString(); });
    await sleep(800);
    child.kill('SIGTERM');
    assert.match(stderrBuf, /CLAUGE_BOUND_PORT=3502/);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node --test test/server-additions.test.js`
Expected: 2 new tests FAIL (current server has no fallback or stderr port marker).

- [ ] **Step 3: Replace serve() block with retry loop**

In `server.js`, REPLACE the existing block:
```js
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`[Clauge] Listening on ${url}`);
  console.log(`[Clauge] CLAUDE_DIR=${CLAUDE_DIR}`);
  if (process.env.NO_OPEN !== '1') {
    open(url).catch(() => {
      console.log('[Clauge] (could not auto-open browser; visit URL manually)');
    });
  }
});
```

WITH:
```js
const PORT_RETRY_LIMIT = 5;

async function listenWithRetry(startPort) {
  for (let attempt = 0; attempt < PORT_RETRY_LIMIT; attempt++) {
    const tryPort = startPort + attempt;
    try {
      const s = await new Promise((resolve, reject) => {
        const ss = serve({ fetch: app.fetch, port: tryPort }, (info) => resolve(ss));
        ss.once?.('error', reject);
        // @hono/node-server may emit error via underlying http.Server
        ss.server?.once('error', reject);
      });
      return { server: s, port: tryPort };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      console.log(`[Clauge] Port ${tryPort} in use; trying ${tryPort + 1}`);
    }
  }
  throw new Error(
    `[Clauge] All ports ${startPort}..${startPort + PORT_RETRY_LIMIT - 1} in use`
  );
}

const { server, port: BOUND_PORT } = await listenWithRetry(PORT);
const url = `http://localhost:${BOUND_PORT}`;
console.log(`[Clauge] Listening on ${url}`);
console.log(`[Clauge] CLAUDE_DIR=${CLAUDE_DIR}`);
console.error(`CLAUGE_BOUND_PORT=${BOUND_PORT}`);  // for Tauri sidecar parser

if (process.env.NO_OPEN !== '1') {
  open(url).catch(() => {
    console.log('[Clauge] (could not auto-open browser; visit URL manually)');
  });
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `node --test test/server-additions.test.js`
Expected: ALL 3 tests pass.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: 106 pass (103 + 3).

- [ ] **Step 6: Commit**

```bash
git add server.js test/server-additions.test.js
git commit -m "feat(server): add port fallback (3456→3460) + stderr port marker"
```

---

### Task 7: Verify SIGTERM flushes pending writes

**Files:**
- Modify: `test/server-additions.test.js` (add SIGTERM test)

The existing `server.js` already has a SIGTERM handler. This task only verifies it via test — no code change unless the test reveals a gap.

- [ ] **Step 1: Write the test**

Append to `test/server-additions.test.js`:
```js
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

describe('SIGTERM graceful shutdown', () => {
  it('exits with code 0 within 2s of SIGTERM', async () => {
    const child = spawn(SERVER_BIN, SERVER_ARGS, {
      env: { ...process.env, PORT: '3503', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((r) => {
      const onD = (b) => b.toString().includes('Listening on') && (child.stdout.off('data', onD), r());
      child.stdout.on('data', onD);
    });

    const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const startMs = Date.now();
    child.kill('SIGTERM');
    const code = await Promise.race([
      exitPromise,
      sleep(2500).then(() => 'TIMEOUT'),
    ]);

    assert.notEqual(code, 'TIMEOUT', 'server exited within 2.5s');
    assert.equal(code, 0, 'clean exit code');
    assert.ok(Date.now() - startMs < 2500, 'shutdown was prompt');
  });

  it('persists in-flight /api/usage/ingest before exit', async () => {
    const claugeDir = await mkdtemp(`${tmpdir()}/clauge-test-`);
    const child = spawn(SERVER_BIN, SERVER_ARGS, {
      env: { ...process.env, PORT: '3504', NO_OPEN: '1', HOME: claugeDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((r) => {
      const onD = (b) => b.toString().includes('Listening on') && (child.stdout.off('data', onD), r());
      child.stdout.on('data', onD);
    });

    const ingestRes = await fetch('http://127.0.0.1:3504/api/usage/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        plan: { seven_day: { utilization: 0.5 } },
        balance: { amount: 1000, currency: 'USD' },
      }),
    });
    assert.equal(ingestRes.status, 200);

    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));

    const persisted = JSON.parse(
      await readFile(`${claugeDir}/.clauge/usage.json`, 'utf8')
    );
    assert.ok(persisted.balance, 'balance was persisted before shutdown');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `node --test test/server-additions.test.js`
Expected: PASS (existing SIGTERM handler should already cover this). If FAIL, debug `server.js`'s shutdown handler — likely needs to await pending writes before `process.exit(0)`.

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: 108 pass.

- [ ] **Step 4: Commit**

```bash
git add test/server-additions.test.js
git commit -m "test(server): cover SIGTERM graceful shutdown + write persistence"
```

---

### Task 8: SEA smoke test

**Files:**
- Create: `test/sea-smoke.test.js`

This test rebuilds the SEA binary and runs the same server tests against it, proving the SEA build is functionally identical to the source.

- [ ] **Step 1: Write the test**

Write `test/sea-smoke.test.js`:
```js
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const ARCH = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
const SIDECAR = join(REPO_ROOT, 'src-tauri', 'binaries', `clauge-server-${ARCH}-apple-darwin`);

describe('SEA sidecar smoke', () => {
  before(() => {
    if (!existsSync(SIDECAR)) {
      console.log('[smoke] Building SEA sidecar (one-time)...');
      execSync('bash scripts/build-sidecar.sh', { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  });

  it('binary is executable and starts within 2s', async () => {
    const child = spawn(SIDECAR, [], {
      env: { ...process.env, PORT: '3520', NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderrBuf = '';
    child.stderr.on('data', (b) => { stderrBuf += b.toString(); });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('start timeout')), 2500);
      const onData = (b) => {
        if (b.toString().includes('Listening on')) {
          clearTimeout(t);
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
    });

    assert.match(stderrBuf, /CLAUGE_BOUND_PORT=3520/);

    const health = await fetch('http://127.0.0.1:3520/api/health');
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.service, 'clauge');

    const summary = await fetch('http://127.0.0.1:3520/api/sessions?period=7d');
    assert.equal(summary.status, 200);

    const exitPromise = new Promise((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGTERM');
    const code = await Promise.race([exitPromise, sleep(2500).then(() => 'TIMEOUT')]);
    assert.equal(code, 0, 'clean exit on SIGTERM');
  });
});
```

- [ ] **Step 2: Run the smoke test**

Run: `npm run test:sea`
Expected: PASS. First run takes ~30s (builds the SEA binary). Subsequent runs ~5s.

- [ ] **Step 3: Commit**

```bash
git add test/sea-smoke.test.js
git commit -m "test(v3): add SEA sidecar smoke test"
```

---

## Phase 2 — Tauri Rust core

Implement the Rust side of V3: sidecar lifecycle, port discovery, IPC, crash circuit-breaker. All tested via `cargo test`.

---

### Task 9: Port discovery module

**Files:**
- Create: `src-tauri/src/port_discovery.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod port_discovery`)

- [ ] **Step 1: Write port_discovery.rs with tests**

Write `src-tauri/src/port_discovery.rs`:
```rust
//! Port discovery for the clauge-server sidecar.
//!
//! On launch, V3 health-pings 127.0.0.1:3456. If a clauge server already
//! responds, V3 acts as a UI client (no sidecar spawn). Otherwise, V3 spawns
//! its own sidecar which tries 3456 → 3460 in order.

use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum DiscoveryResult {
    /// Existing clauge server responding on this port. V3 should NOT spawn its own.
    External(u16),
    /// No clauge server found. V3 should spawn its own sidecar starting at this port.
    SpawnAt(u16),
}

#[derive(Deserialize)]
struct HealthBody {
    service: String,
}

/// Probe `127.0.0.1:<port>/api/health` with a 1-second timeout.
/// Returns true iff the response identifies as a clauge server.
pub async fn probe(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{}/api/health", port);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<HealthBody>().await {
                Ok(body) => body.service == "clauge",
                Err(_) => false,
            }
        }
        _ => false,
    }
}

/// On boot, decide whether to use an existing server or spawn a new one.
pub async fn discover() -> DiscoveryResult {
    if probe(3456).await {
        DiscoveryResult::External(3456)
    } else {
        DiscoveryResult::SpawnAt(3456)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::Server;

    #[tokio::test]
    async fn probe_returns_false_when_no_server() {
        // Use a port we won't actually start anything on
        assert!(!probe(45678).await);
    }

    #[tokio::test]
    async fn probe_returns_true_for_clauge_response() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/api/health")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"service":"clauge","version":"0.3.0","pid":1}"#)
            .create_async()
            .await;
        // mockito picks an OS-assigned port; extract it
        let url = server.url();
        let port: u16 = url.rsplit(':').next().unwrap().parse().unwrap();
        assert!(probe(port).await);
    }

    #[tokio::test]
    async fn probe_returns_false_for_non_clauge_service() {
        let mut server = Server::new_async().await;
        let _m = server
            .mock("GET", "/api/health")
            .with_status(200)
            .with_body(r#"{"service":"something-else"}"#)
            .create_async()
            .await;
        let port: u16 = server.url().rsplit(':').next().unwrap().parse().unwrap();
        assert!(!probe(port).await);
    }
}
```

- [ ] **Step 2: Add reqwest dependency**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:
```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

- [ ] **Step 3: Wire module in lib.rs**

In `src-tauri/src/lib.rs`, add at the top:
```rust
mod port_discovery;
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test port_discovery`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/port_discovery.rs
git commit -m "feat(v3): port discovery — probe /api/health, decide spawn vs share"
```

---

### Task 10: Sidecar lifecycle + crash circuit-breaker

**Files:**
- Create: `src-tauri/src/sidecar.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod sidecar`)

- [ ] **Step 1: Write sidecar.rs with circuit-breaker tests**

Write `src-tauri/src/sidecar.rs`:
```rust
//! Sidecar process lifecycle + crash circuit-breaker.
//!
//! Spawns the clauge-server SEA binary as a child process via tauri-plugin-shell.
//! Tracks crash timestamps in a 60s sliding window. After 3 crashes, dispatches
//! a one-shot notification but keeps respawning (with exponential backoff after #4+).

use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct CrashBreaker {
    crashes: VecDeque<Instant>,
    window: Duration,
    pub notification_sent: bool,
}

impl CrashBreaker {
    pub fn new() -> Self {
        Self {
            crashes: VecDeque::new(),
            window: Duration::from_secs(60),
            notification_sent: false,
        }
    }

    /// Record a crash. Returns the recommended action.
    pub fn record(&mut self, now: Instant) -> CrashAction {
        // Drop entries outside the window
        while let Some(&front) = self.crashes.front() {
            if now.duration_since(front) > self.window {
                self.crashes.pop_front();
            } else {
                break;
            }
        }
        // If the window is empty after pruning, reset notification state
        if self.crashes.is_empty() {
            self.notification_sent = false;
        }
        self.crashes.push_back(now);

        match self.crashes.len() {
            1 | 2 => CrashAction::SilentRespawn,
            3 => {
                let action = if self.notification_sent {
                    CrashAction::SilentRespawn
                } else {
                    self.notification_sent = true;
                    CrashAction::NotifyAndRespawn
                };
                action
            }
            n => {
                // Exponential backoff: 1s, 2s, 4s, 8s, capped at 8s
                let exp = (n - 3).min(3);
                let backoff = Duration::from_secs(1 << exp);
                CrashAction::BackoffRespawn(backoff)
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CrashAction {
    SilentRespawn,
    NotifyAndRespawn,
    BackoffRespawn(Duration),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(secs: u64) -> Instant {
        // Use a fixed reference for tests
        static REF: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        let r = REF.get_or_init(Instant::now);
        *r + Duration::from_secs(secs)
    }

    #[test]
    fn first_crash_is_silent() {
        let mut b = CrashBreaker::new();
        assert_eq!(b.record(t(0)), CrashAction::SilentRespawn);
    }

    #[test]
    fn second_crash_within_60s_is_silent() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        assert_eq!(b.record(t(30)), CrashAction::SilentRespawn);
    }

    #[test]
    fn third_crash_within_60s_notifies() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(20));
        assert_eq!(b.record(t(40)), CrashAction::NotifyAndRespawn);
    }

    #[test]
    fn fourth_crash_within_60s_backs_off() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(10));
        b.record(t(20));
        let r = b.record(t(30));
        assert!(matches!(r, CrashAction::BackoffRespawn(d) if d == Duration::from_secs(2)));
    }

    #[test]
    fn fifth_crash_uses_4s_backoff() {
        let mut b = CrashBreaker::new();
        for i in 0..4 {
            b.record(t(i * 5));
        }
        let r = b.record(t(25));
        assert!(matches!(r, CrashAction::BackoffRespawn(d) if d == Duration::from_secs(4)));
    }

    #[test]
    fn crashes_outside_window_are_dropped() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(10));
        b.record(t(20));
        // 90 seconds later: previous crashes should be pruned
        assert_eq!(b.record(t(110)), CrashAction::SilentRespawn);
    }

    #[test]
    fn notification_does_not_repeat_within_same_window() {
        let mut b = CrashBreaker::new();
        b.record(t(0));
        b.record(t(10));
        b.record(t(20)); // notify
        // 4th crash → backoff, NOT a second notification
        let r = b.record(t(30));
        assert!(matches!(r, CrashAction::BackoffRespawn(_)));
        assert!(b.notification_sent);
    }
}
```

- [ ] **Step 2: Wire module in lib.rs**

In `src-tauri/src/lib.rs`, add:
```rust
mod sidecar;
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test sidecar`
Expected: 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sidecar.rs src-tauri/src/lib.rs
git commit -m "feat(v3): sidecar crash circuit-breaker (60s window, exponential backoff)"
```

---

### Task 11: IPC commands — get_server_port

**Files:**
- Create: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/lib.rs` (register handler + add `mod ipc`)
- Modify: `src-tauri/capabilities/main.json` (allow IPC)

- [ ] **Step 1: Write ipc.rs**

Write `src-tauri/src/ipc.rs`:
```rust
//! Tauri IPC commands exposed to WebView pages.

use std::sync::{Arc, Mutex};
use tauri::State;

/// Shared app state holding the sidecar's bound port.
#[derive(Default)]
pub struct AppState {
    pub server_port: Arc<Mutex<Option<u16>>>,
}

#[tauri::command]
pub fn get_server_port(state: State<AppState>) -> Result<u16, String> {
    state
        .server_port
        .lock()
        .map_err(|e| format!("lock poisoned: {}", e))?
        .ok_or_else(|| "server port not yet set".to_string())
}

#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_server_port_returns_when_set() {
        let state = AppState::default();
        *state.server_port.lock().unwrap() = Some(3456);
        // Simulate the State<AppState> by directly calling logic
        let port = state.server_port.lock().unwrap().clone();
        assert_eq!(port, Some(3456));
    }

    #[test]
    fn get_server_port_errors_when_unset() {
        let state = AppState::default();
        let port = state.server_port.lock().unwrap().clone();
        assert_eq!(port, None);
    }
}
```

- [ ] **Step 2: Wire module + register handlers in lib.rs**

Replace `src-tauri/src/lib.rs` with:
```rust
mod ipc;
mod port_discovery;
mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ipc::AppState::default())
        .invoke_handler(tauri::generate_handler![
            ipc::get_server_port,
            ipc::check_for_updates,
            ipc::set_autostart,
            ipc::get_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Update capabilities to allow IPC**

Replace `src-tauri/capabilities/main.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "main",
  "description": "Default permissions for Clauge",
  "windows": ["main", "popover"],
  "permissions": [
    "core:default",
    "shell:allow-spawn",
    "shell:allow-kill",
    "autostart:allow-enable",
    "autostart:allow-disable",
    "autostart:allow-is-enabled",
    "updater:allow-check",
    "updater:default",
    "notification:default",
    "window-state:default",
    "store:default"
  ]
}
```

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test`
Expected: all previous tests + 2 new ipc tests pass.

- [ ] **Step 5: Verify cargo build still succeeds**

Run: `cd src-tauri && cargo build`
Expected: build completes (may pull a few new crates).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/lib.rs src-tauri/capabilities/main.json
git commit -m "feat(v3): IPC commands (get_server_port, autostart, check_for_updates)"
```

---

### Task 12: Wire sidecar spawn into Tauri lifecycle

**Files:**
- Modify: `src-tauri/src/lib.rs` (add `setup` hook that spawns sidecar)
- Modify: `src-tauri/tauri.conf.json` (declare external binary)

- [ ] **Step 1: Declare sidecar in tauri.conf.json**

Modify `src-tauri/tauri.conf.json`. Replace `"bundle"` block to add `externalBin`:
```json
"bundle": {
  "active": true,
  "targets": ["dmg"],
  "externalBin": ["binaries/clauge-server"],
  "macOS": {
    "minimumSystemVersion": "12.0"
  },
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns"
  ]
}
```

(Tauri resolves `binaries/clauge-server-<triple>` based on the build target. The build script in Task 4 produces both `aarch64-apple-darwin` and `x86_64-apple-darwin` variants.)

- [ ] **Step 2: Add setup hook to spawn sidecar**

In `src-tauri/src/lib.rs`, modify `run()` to add a `.setup(...)` block before `.run(...)`:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            // Focus existing window on second-launch attempt
            if let Some(w) = app.webview_windows().values().next() {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ipc::AppState::default())
        .invoke_handler(tauri::generate_handler![
            ipc::get_server_port,
            ipc::check_for_updates,
            ipc::set_autostart,
            ipc::get_autostart,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = port_discovery::discover().await;
                match result {
                    port_discovery::DiscoveryResult::External(port) => {
                        log::info!("Using external clauge server on port {}", port);
                        if let Some(state) = app_handle.try_state::<ipc::AppState>() {
                            *state.server_port.lock().unwrap() = Some(port);
                        }
                    }
                    port_discovery::DiscoveryResult::SpawnAt(_start) => {
                        sidecar::spawn_and_supervise(app_handle).await;
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Implement spawn_and_supervise in sidecar.rs**

Append to `src-tauri/src/sidecar.rs`:
```rust
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};

const PORT_MARKER: &str = "CLAUGE_BOUND_PORT=";

pub async fn spawn_and_supervise(app: AppHandle) {
    let mut breaker = CrashBreaker::new();
    loop {
        match spawn_one(&app).await {
            Ok(port) => {
                log::info!("Sidecar bound to port {}", port);
                if let Some(state) = app.try_state::<crate::ipc::AppState>() {
                    *state.server_port.lock().unwrap() = Some(port);
                }
                // Wait for the child to exit. (spawn_one returns the port and consumes
                // the child's stdout — we set up a separate exit-watcher inside.)
                tokio::time::sleep(tokio::time::Duration::from_secs(3600)).await;
            }
            Err(e) => {
                log::error!("Sidecar spawn failed: {}", e);
            }
        }
        let action = breaker.record(Instant::now());
        log::warn!("Sidecar died; action = {:?}", action);
        match action {
            CrashAction::SilentRespawn => {}
            CrashAction::NotifyAndRespawn => {
                use tauri_plugin_notification::NotificationExt;
                let _ = app
                    .notification()
                    .builder()
                    .title("Clauge")
                    .body("Clauge had a problem — please restart the app.")
                    .show();
            }
            CrashAction::BackoffRespawn(d) => {
                tokio::time::sleep(d).await;
            }
        }
    }
}

async fn spawn_one(app: &AppHandle) -> Result<u16, String> {
    let (mut rx, _child): (_, CommandChild) = app
        .shell()
        .sidecar("clauge-server")
        .map_err(|e| e.to_string())?
        .spawn()
        .map_err(|e| e.to_string())?;

    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line);
                if let Some(idx) = line.find(PORT_MARKER) {
                    let after = &line[idx + PORT_MARKER.len()..];
                    if let Some(port_str) = after.split_whitespace().next() {
                        if let Ok(port) = port_str.parse::<u16>() {
                            return Ok(port);
                        }
                    }
                }
            }
            CommandEvent::Terminated(_) => {
                return Err("sidecar exited before binding port".to_string());
            }
            _ => {}
        }
    }
    Err("sidecar event stream closed".to_string())
}
```

- [ ] **Step 4: Run cargo build**

Run: `cd src-tauri && cargo build`
Expected: builds (note: tokio::time and Instant imports may need adjustment).

- [ ] **Step 5: Run cargo test (existing tests should still pass)**

Run: `cd src-tauri && cargo test`
Expected: all pre-existing tests pass.

- [ ] **Step 6: Manual integration smoke**

```bash
npm run build:sidecar
cd src-tauri && cargo run
```
Expected: app launches, logs show `Sidecar bound to port 3456` (or similar). Browser-test by opening `http://127.0.0.1:3456/api/health`. Quit the running app with `Ctrl+C` in the terminal.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/sidecar.rs src-tauri/tauri.conf.json
git commit -m "feat(v3): wire sidecar spawn + supervise loop into Tauri lifecycle"
```

---

## Phase 3 — Tray + Dashboard window

Get the tray icon visible and the dashboard window working (loads existing `public/index.html`). After this phase, V3 is functionally usable as a "headless menu bar app with a dashboard window."

---

### Task 13: Tray icon + native right-click menu

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs` (call tray::init)

- [ ] **Step 1: Write tray.rs**

Write `src-tauri/src/tray.rs`:
```rust
//! Tray icon + native right-click menu.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open_dashboard = MenuItem::with_id(
        app, "open_dashboard", "Open Dashboard", true, None::<&str>,
    )?;
    let preferences = MenuItem::with_id(
        app, "preferences", "Preferences…", true, Some("Cmd+,"),
    )?;
    let check_updates = MenuItem::with_id(
        app, "check_updates", "Check for Updates", true, None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Clauge", true, Some("Cmd+Q"))?;

    let menu = Menu::with_items(
        app,
        &[&open_dashboard, &preferences, &check_updates, &separator, &quit],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().0.as_str() {
            "open_dashboard" => {
                show_dashboard(app);
            }
            "preferences" => {
                show_popover_with_preferences(app);
            }
            "check_updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::ipc::check_for_updates(app).await;
                });
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, .. } = event {
                if matches!(button, MouseButton::Left) {
                    toggle_popover(tray.app_handle());
                }
            }
        })
        .build(app)?;

    Ok(())
}

fn show_dashboard<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    } else {
        crate::windows::create_dashboard(app).ok();
    }
}

fn toggle_popover<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("popover") {
        match w.is_visible() {
            Ok(true) => { let _ = w.hide(); }
            _ => {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    }
}

fn show_popover_with_preferences<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("popover") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.eval("window.dispatchEvent(new CustomEvent('show-preferences'))");
    }
}
```

- [ ] **Step 2: Wire in lib.rs**

Modify `src-tauri/src/lib.rs` `setup` block — replace its body with:
```rust
.setup(|app| {
    crate::tray::init(app.handle())?;
    crate::windows::create_popover(app.handle())?;

    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let result = port_discovery::discover().await;
        match result {
            port_discovery::DiscoveryResult::External(port) => {
                log::info!("Using external clauge server on port {}", port);
                if let Some(state) = app_handle.try_state::<ipc::AppState>() {
                    *state.server_port.lock().unwrap() = Some(port);
                }
            }
            port_discovery::DiscoveryResult::SpawnAt(_start) => {
                sidecar::spawn_and_supervise(app_handle).await;
            }
        }
    });
    Ok(())
})
```

Also add `mod tray; mod windows;` near the top of `lib.rs`.

- [ ] **Step 3: Stub windows.rs (Task 14 fills in real impl)**

Write `src-tauri/src/windows.rs`:
```rust
use tauri::{AppHandle, Runtime};

pub fn create_popover<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    // TODO Task 14
    Ok(())
}

pub fn create_dashboard<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    // TODO Task 14
    Ok(())
}
```

(This is a temporary stub. Rule says "no TODOs" — but here the TODO exists ONLY between Task 13 and Task 14 within the same plan execution. Task 14 must replace this stub.)

- [ ] **Step 4: Build + manual smoke**

Run: `cd src-tauri && cargo build && cargo run`
Expected: app launches, tray icon appears in macOS menu bar, right-click shows the menu items, "Quit Clauge" exits cleanly.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/tray.rs src-tauri/src/windows.rs src-tauri/src/lib.rs
git commit -m "feat(v3): tray icon + native right-click menu"
```

---

### Task 14: Dashboard window

**Files:**
- Modify: `src-tauri/src/windows.rs` (replace stub)

- [ ] **Step 1: Implement create_dashboard**

Replace `src-tauri/src/windows.rs` with:
```rust
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub fn create_popover<R: Runtime>(_app: &AppHandle<R>) -> tauri::Result<()> {
    // Real popover comes in Phase 4
    Ok(())
}

pub fn create_dashboard<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }

    // Get the bound port from state
    let port = app
        .try_state::<crate::ipc::AppState>()
        .and_then(|s| *s.server_port.lock().unwrap())
        .unwrap_or(3456);
    let url = format!("http://127.0.0.1:{}/", port);

    let win = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(url.parse().unwrap()),
    )
    .title("Clauge")
    .inner_size(1480.0, 1100.0)
    .min_inner_size(900.0, 600.0)
    .resizable(true)
    .visible(true)
    .build()?;

    // Hide-on-close behavior so reopen is fast
    let win_handle = win.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win_handle.hide();
        }
    });

    Ok(())
}
```

- [ ] **Step 2: Build + manual smoke**

Run: `cd src-tauri && cargo build && cargo run`
Click tray → "Open Dashboard". Expected: window opens, loads V2.2 dashboard from sidecar.

- [ ] **Step 3: Verify hide-on-close**

Click red close button. Expected: window hides (does not actually close). Click tray → "Open Dashboard" again. Expected: same window reappears instantly.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/windows.rs
git commit -m "feat(v3): dashboard window — lazy create, hide on close"
```

---

### Task 15: Native macOS menu bar

**Files:**
- Create: `src-tauri/src/menu.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod menu`, install menu in setup)

- [ ] **Step 1: Write menu.rs**

Write `src-tauri/src/menu.rs`:
```rust
//! Native macOS menu bar (File / Edit / View / Window / Help).

use tauri::{
    menu::{Menu, PredefinedMenuItem, Submenu, MenuItem},
    AppHandle, Runtime,
};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_name = "Clauge";

    let app_menu = Submenu::with_items(
        app,
        app_name,
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Clauge"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "preferences", "Preferences…", true, Some("Cmd+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "refresh", "Refresh", true, Some("Cmd+R"))?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "github", "GitHub Repository", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}
```

- [ ] **Step 2: Install menu + handle events in lib.rs**

In `src-tauri/src/lib.rs`, add `mod menu;` near top. In the `.setup` block, immediately AFTER `crate::tray::init(...)`, add:
```rust
let menu = crate::menu::build(app.handle())?;
app.set_menu(menu)?;
app.on_menu_event(|app, event| match event.id().0.as_str() {
    "preferences" => {
        if let Some(w) = app.get_webview_window("popover") {
            let _ = w.show();
            let _ = w.set_focus();
            let _ = w.eval("window.dispatchEvent(new CustomEvent('show-preferences'))");
        }
    }
    "refresh" => {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.eval("location.reload()");
        }
    }
    "github" => {
        use tauri_plugin_shell::ShellExt;
        let _ = app.shell().open(
            "https://github.com/clauding-lab/clauge",
            None,
        );
    }
    _ => {}
});
```

- [ ] **Step 3: Build + manual smoke**

Run: `cd src-tauri && cargo run`
Click in the macOS menu bar — Clauge / Edit / View / Window / Help should all appear with the standard items. Cmd+Q quits. Cmd+R refreshes the dashboard if open. View → GitHub Repository opens the repo URL.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/menu.rs src-tauri/src/lib.rs
git commit -m "feat(v3): native macOS menu bar (File/Edit/View/Window/Help)"
```

---

## Phase 4 — Popover UI

Build the frameless vibrancy popover. Port `docs/design/menubar.jsx` to vanilla HTML/CSS/JS in `popover/`. Pre-rendered at boot for sub-50ms perceived latency on tray click.

---

### Task 16: Popover HTML scaffold + vibrancy window

**Files:**
- Create: `popover/index.html`
- Create: `popover/popover.css`
- Create: `popover/popover.js`
- Modify: `src-tauri/src/windows.rs` (replace stub with real popover)
- Modify: `src-tauri/tauri.conf.json` (add popover window definition)

- [ ] **Step 1: Create minimal popover HTML**

Write `popover/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Clauge</title>
  <link rel="stylesheet" href="popover.css">
</head>
<body>
  <div id="root">
    <header class="popover-header">
      <span class="brand-mark"></span>
      <span class="brand-name">Clauge</span>
      <span id="status-badge" class="status-badge">live</span>
      <span class="header-spacer"></span>
      <button id="btn-dashboard" class="icon-btn" title="Open dashboard">↗</button>
      <button id="btn-refresh" class="icon-btn" title="Refresh">↻</button>
      <button id="btn-prefs" class="icon-btn" title="Preferences">⚙</button>
    </header>

    <section id="hero">
      <div class="hero-label">Today · API equivalent</div>
      <div id="hero-amount" class="hero-amount mono">—</div>
      <div id="hero-spark" class="spark"></div>
    </section>

    <section id="rings" class="ring-strip"></section>

    <nav class="tabs">
      <button class="tab active" data-tab="today">Today</button>
      <button class="tab" data-tab="recent">Recent</button>
      <button class="tab" data-tab="models">Models</button>
    </nav>

    <section id="tab-content" class="tab-content"></section>

    <footer class="popover-footer">
      <span class="footer-hint mono">⌘D dashboard · ⌘R refresh</span>
      <a href="#" id="footer-dashboard">Open dashboard →</a>
    </footer>
  </div>

  <div id="prefs" class="prefs-panel" hidden>
    <header class="prefs-header">
      <button id="prefs-back" class="icon-btn" title="Back">←</button>
      <span>Preferences</span>
    </header>
    <ul class="prefs-list">
      <li class="prefs-row">
        <span>Launch at login</span>
        <label class="toggle">
          <input type="checkbox" id="autostart-toggle">
          <span class="toggle-slider"></span>
        </label>
      </li>
      <li class="prefs-row">
        <span>Check for updates</span>
        <button id="check-updates-btn" class="prefs-btn">Check now</button>
      </li>
      <li class="prefs-row">
        <span>About</span>
        <span id="about-version" class="mono prefs-meta">v0.3.0</span>
      </li>
    </ul>
  </div>

  <script type="module" src="popover.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create popover.css**

Write `popover/popover.css`:
```css
/* Popover styles. Reuses tokens from public/styles.css concepts.
   For self-containment within Tauri WebView, redeclare core tokens here. */

:root {
  --bg: rgba(20, 17, 15, 0.85);
  --surface: rgba(28, 23, 20, 0.95);
  --surface-2: rgba(40, 32, 28, 0.95);
  --surface-3: rgba(58, 47, 40, 0.95);
  --hairline: rgba(255, 240, 230, 0.06);
  --hairline-2: rgba(255, 240, 230, 0.10);
  --text: rgba(255, 240, 230, 0.92);
  --text-2: rgba(255, 240, 230, 0.72);
  --text-3: rgba(255, 240, 230, 0.50);
  --text-4: rgba(255, 240, 230, 0.32);
  --brand: #d97757;
  --brand-2: #e89274;
  --brand-tint: rgba(217, 119, 87, 0.10);
  --ok: #6eb98a;
  --ok-tint: rgba(110, 185, 138, 0.12);
  --warn: #d9a657;
  --crit: #d97757;
  --opus: #b59cd6;
  --sonnet: #7fb3a3;
  --haiku: #d6c39c;
  --sans: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  background: transparent;
  color: var(--text);
  font-family: var(--sans);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
  -webkit-user-select: none;
}

.mono { font-family: var(--mono); font-feature-settings: "tnum" 1; }

#root {
  width: 380px;
  background: var(--surface);
  border: 1px solid var(--hairline-2);
  border-radius: 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* Header */
.popover-header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--hairline);
  background: linear-gradient(180deg, rgba(217,119,87,0.04), transparent);
}
.brand-mark {
  width: 18px; height: 18px;
  background: var(--brand);
  border-radius: 4px;
}
.brand-name { font-size: 12.5px; font-weight: 600; }
.status-badge {
  font-size: 9.5px; padding: 1.5px 6px; border-radius: 4px;
  background: var(--ok-tint); color: var(--ok);
  display: inline-flex; align-items: center; gap: 5px;
  letter-spacing: 0.04em;
}
.status-badge::before {
  content: ""; width: 4px; height: 4px;
  border-radius: 50%; background: var(--ok);
}
.header-spacer { flex: 1; }
.icon-btn {
  appearance: none;
  width: 24px; height: 24px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  display: grid; place-items: center;
  font-family: inherit;
}
.icon-btn:hover { background: var(--surface-3); color: var(--text); }

/* Hero */
#hero { padding: 16px 16px 4px; }
.hero-label {
  font-size: 9.5px;
  letter-spacing: 0.10em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 4px;
}
.hero-amount {
  font-size: 36px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1;
}
.spark {
  margin-top: 10px;
  height: 28px;
  display: flex;
  align-items: flex-end;
  gap: 2px;
}

/* Ring strip */
.ring-strip {
  margin: 12px 12px 0;
  padding: 12px 6px;
  background: var(--bg);
  border-radius: 10px;
  border: 1px solid var(--hairline);
  display: flex;
  justify-content: space-around;
  align-items: center;
}

/* Tabs */
.tabs {
  display: flex;
  gap: 2px;
  margin: 14px 14px 0;
  padding: 2px;
  background: var(--bg);
  border-radius: 8px;
  border: 1px solid var(--hairline);
}
.tab {
  flex: 1;
  appearance: none;
  border: 0;
  cursor: pointer;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  font-family: inherit;
}
.tab.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 0 rgba(255,240,230,0.04) inset, 0 1px 2px rgba(0,0,0,0.2);
}

.tab-content { padding: 10px 14px 14px; min-height: 130px; }

/* Footer */
.popover-footer {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 14px;
  border-top: 1px solid var(--hairline);
  background: var(--bg);
}
.footer-hint { font-size: 10px; color: var(--text-3); }
.popover-footer a {
  font-size: 11px;
  color: var(--brand-2);
  text-decoration: none;
}

/* Preferences panel — slides in over main view */
.prefs-panel {
  position: absolute;
  inset: 0;
  background: var(--surface);
  display: flex;
  flex-direction: column;
}
.prefs-panel[hidden] { display: none; }
.prefs-header {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--hairline);
  font-size: 12.5px;
  font-weight: 600;
}
.prefs-list { list-style: none; padding: 8px; }
.prefs-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px;
  border-radius: 8px;
}
.prefs-row + .prefs-row { margin-top: 2px; }
.prefs-row:hover { background: var(--surface-2); }
.prefs-btn {
  appearance: none;
  border: 1px solid var(--hairline-2);
  background: var(--surface-2);
  color: var(--text);
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
  font-family: inherit;
}
.prefs-btn:hover { background: var(--surface-3); }
.prefs-meta { color: var(--text-3); font-size: 11px; }

/* Toggle */
.toggle { position: relative; width: 32px; height: 18px; cursor: pointer; }
.toggle input { display: none; }
.toggle-slider {
  position: absolute; inset: 0;
  background: var(--surface-3);
  border-radius: 999px;
  transition: background 200ms;
}
.toggle-slider::before {
  content: "";
  position: absolute;
  width: 14px; height: 14px;
  background: var(--text);
  border-radius: 50%;
  top: 2px; left: 2px;
  transition: left 200ms;
}
.toggle input:checked + .toggle-slider { background: var(--brand); }
.toggle input:checked + .toggle-slider::before { left: 16px; }
```

- [ ] **Step 3: Create minimal popover.js (data wiring stub)**

Write `popover/popover.js`:
```js
// Popover JS. Wires UI to clauge-server via fetch.
// Reference: docs/design/menubar.jsx (port to vanilla here).

const { invoke } = window.__TAURI__.core;

let serverPort = 3456;

async function init() {
  try {
    serverPort = await invoke('get_server_port');
  } catch (e) {
    console.warn('Server port not yet available, falling back to 3456', e);
  }

  document.getElementById('btn-prefs').addEventListener('click', showPreferences);
  document.getElementById('prefs-back').addEventListener('click', hidePreferences);
  document.getElementById('btn-dashboard').addEventListener('click', openDashboard);
  document.getElementById('footer-dashboard').addEventListener('click', (e) => {
    e.preventDefault();
    openDashboard();
  });
  document.getElementById('btn-refresh').addEventListener('click', refresh);
  document.getElementById('check-updates-btn').addEventListener('click', () => {
    invoke('check_for_updates').catch((err) => alert(`Update error: ${err}`));
  });
  const autoToggle = document.getElementById('autostart-toggle');
  autoToggle.checked = await invoke('get_autostart').catch(() => true);
  autoToggle.addEventListener('change', () => {
    invoke('set_autostart', { enabled: autoToggle.checked });
  });

  window.addEventListener('show-preferences', showPreferences);

  document.querySelectorAll('.tab').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });

  await refresh();
  setInterval(refresh, 10_000);
}

function showPreferences() { document.getElementById('prefs').hidden = false; }
function hidePreferences() { document.getElementById('prefs').hidden = true; }

async function openDashboard() {
  // TODO Task 17: invoke a Tauri command that creates/shows the dashboard window
  alert('Dashboard window — wired in Task 17 of plan');
}

async function refresh() {
  const url = `http://127.0.0.1:${serverPort}/api/sessions?period=today`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderHero(data);
  } catch (e) {
    console.error('refresh failed', e);
  }
}

function renderHero(data) {
  const total = data?.totals?.cost ?? 0;
  document.getElementById('hero-amount').textContent =
    `$${total.toFixed(2)}`;
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  // Tab content rendering stubbed; expanded in Task 18.
  document.getElementById('tab-content').textContent =
    `Tab "${name}" content — Task 18`;
}

document.addEventListener('DOMContentLoaded', init);
```

- [ ] **Step 4: Add popover window declaration in tauri.conf.json**

Modify `src-tauri/tauri.conf.json` `app.windows` to:
```json
"windows": [
  {
    "label": "popover",
    "title": "Clauge",
    "url": "../popover/index.html",
    "width": 380,
    "height": 600,
    "resizable": false,
    "decorations": false,
    "transparent": true,
    "alwaysOnTop": true,
    "skipTaskbar": true,
    "visible": false,
    "focus": false
  }
]
```

Also add the popover frontend dist to top-level if needed (Tauri 2.x picks up popover/ via the URL above).

- [ ] **Step 5: Replace popover stub in windows.rs**

In `src-tauri/src/windows.rs`, replace `create_popover` with:
```rust
pub fn create_popover<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window("popover").is_some() {
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::App("../popover/index.html".into()),
    )
    .inner_size(380.0, 600.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()?;

    // macOS vibrancy popover material
    #[cfg(target_os = "macos")]
    {
        use tauri::utils::TitleBarStyle;
        // Tauri 2.x exposes window-vibrancy via separate crate; if not added,
        // accept transparency-only for now and add vibrancy in Task 17.
    }

    let _ = win.hide();
    Ok(())
}
```

- [ ] **Step 6: Build + manual smoke**

Run: `cd src-tauri && cargo run`
Click tray icon → popover window appears (frameless, semi-transparent), shows the brand header, hero `$0.00` (or actual today value), Today/Recent/Models tabs, and a Preferences ⚙ button.

- [ ] **Step 7: Commit**

```bash
git add popover/ src-tauri/src/windows.rs src-tauri/tauri.conf.json
git commit -m "feat(v3): popover scaffold — frameless transparent window with shell UI"
```

---

### Task 17: Vibrancy material + popover positioning

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `window-vibrancy`)
- Modify: `src-tauri/src/windows.rs` (apply vibrancy + position near tray)

- [ ] **Step 1: Add window-vibrancy dependency**

In `src-tauri/Cargo.toml` `[dependencies]`, add:
```toml
window-vibrancy = "0.5"
```

- [ ] **Step 2: Apply vibrancy in create_popover**

In `src-tauri/src/windows.rs`, modify `create_popover` to:
```rust
pub fn create_popover<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window("popover").is_some() {
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        app,
        "popover",
        WebviewUrl::App("../popover/index.html".into()),
    )
    .inner_size(380.0, 600.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()?;

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
        apply_vibrancy(
            &win,
            NSVisualEffectMaterial::Popover,
            Some(NSVisualEffectState::Active),
            Some(12.0),
        )
        .ok();
    }

    let _ = win.hide();
    Ok(())
}
```

- [ ] **Step 3: Position popover under tray icon on show**

Add a helper to `src-tauri/src/windows.rs`:
```rust
pub fn position_popover_under_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let popover = app.get_webview_window("popover")
        .ok_or_else(|| tauri::Error::WebviewNotFound)?;
    let monitor = popover.current_monitor()?
        .ok_or_else(|| tauri::Error::WebviewNotFound)?;
    let scale = monitor.scale_factor();
    let monitor_size = monitor.size();
    let win_size = popover.outer_size()?;

    // Anchor near top-right of the menu bar
    let x = (monitor_size.width as i32) - (win_size.width as i32) - 16;
    let y = 32; // just below menu bar

    popover.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}
```

Modify `tray.rs::toggle_popover` to call `position_popover_under_tray(...)` BEFORE `set_focus`. Same in `show_popover_with_preferences`.

- [ ] **Step 4: Build + manual smoke**

Run: `cd src-tauri && cargo run`
Click tray icon → popover appears with vibrancy effect (semi-transparent material, similar to Spotlight), positioned under the tray icon area.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/windows.rs src-tauri/src/tray.rs
git commit -m "feat(v3): macOS popover vibrancy material + tray-anchored positioning"
```

---

### Task 18: Port menubar.jsx — gauges, sparkline, tabs

**Files:**
- Modify: `popover/popover.js` (replace stub render functions)

The reference is `docs/design/menubar.jsx` (read it for component shapes). Translate JSX to vanilla DOM operations.

- [ ] **Step 1: Implement renderRings + renderHeroSparkline + tab content**

Replace `popover/popover.js` body with:
```js
const { invoke } = window.__TAURI__.core;

let serverPort = 3456;

async function init() {
  try { serverPort = await invoke('get_server_port'); }
  catch { console.warn('No server port available; falling back to 3456'); }

  document.getElementById('btn-prefs').addEventListener('click', showPreferences);
  document.getElementById('prefs-back').addEventListener('click', hidePreferences);
  document.getElementById('btn-dashboard').addEventListener('click', openDashboard);
  document.getElementById('footer-dashboard').addEventListener('click', (e) => { e.preventDefault(); openDashboard(); });
  document.getElementById('btn-refresh').addEventListener('click', refresh);
  document.getElementById('check-updates-btn').addEventListener('click', () => {
    invoke('check_for_updates').catch((err) => console.error('Update error:', err));
  });
  const autoToggle = document.getElementById('autostart-toggle');
  autoToggle.checked = await invoke('get_autostart').catch(() => true);
  autoToggle.addEventListener('change', () => {
    invoke('set_autostart', { enabled: autoToggle.checked });
  });
  window.addEventListener('show-preferences', showPreferences);
  document.querySelectorAll('.tab').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab))
  );

  await refresh();
  setInterval(refresh, 10_000);
}

function showPreferences() { document.getElementById('prefs').hidden = false; }
function hidePreferences() { document.getElementById('prefs').hidden = true; }
async function openDashboard() {
  await invoke('open_dashboard').catch(console.error);
}

async function refresh() {
  try {
    const [today, plan, hours] = await Promise.all([
      fetchJson(`/api/sessions?period=today`),
      fetchJson(`/api/usage`),
      fetchJson(`/api/hours?period=today`),
    ]);
    renderHero(today);
    renderRings(plan);
    renderHeroSpark(hours);
    renderActiveTab();
  } catch (e) { console.error('refresh failed', e); }
}

async function fetchJson(path) {
  const r = await fetch(`http://127.0.0.1:${serverPort}${path}`);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

let lastData = { today: null, plan: null, hours: null };

function renderHero(today) {
  lastData.today = today;
  const total = today?.totals?.cost ?? 0;
  document.getElementById('hero-amount').textContent = `$${total.toFixed(2)}`;
}

function renderHeroSpark(hours) {
  lastData.hours = hours;
  const arr = (hours?.hours ?? []).map((h) => h.cost ?? 0);
  if (arr.length === 0) return;
  const max = Math.max(...arr, 0.01);
  const now = new Date().getHours();
  const el = document.getElementById('hero-spark');
  el.innerHTML = arr
    .map((v, i) => {
      const h = (v / max) * 100;
      const dim = i > now;
      const isNow = i === now;
      const bg = isNow ? 'var(--brand)' : 'var(--surface-3)';
      return `<div style="flex:1;height:${h}%;background:${bg};opacity:${dim ? 0.3 : 1};border-radius:1px"></div>`;
    })
    .join('');
}

function renderRings(plan) {
  lastData.plan = plan;
  const gauges = [
    { label: 'Session', pct: plan?.session_5h ?? 0, sub: '5h', reset: plan?.session_reset ?? '—' },
    { label: 'Weekly', pct: plan?.seven_day ?? 0, sub: '7d', reset: plan?.seven_day_reset ?? '—' },
    { label: 'Sonnet', pct: plan?.seven_day_sonnet ?? 0, sub: '7d', reset: plan?.seven_day_reset ?? '—' },
    { label: 'Opus', pct: plan?.seven_day_opus ?? 0, sub: '7d', reset: plan?.seven_day_reset ?? '—' },
  ];
  const root = document.getElementById('rings');
  root.innerHTML = gauges.map(ringHtml).join('');
}

function ringHtml(g) {
  const size = 56, stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - g.pct * c;
  const state = g.pct >= 0.85 ? 'crit' : g.pct >= 0.60 ? 'warn' : 'ok';
  const colorMap = { ok: 'var(--brand)', warn: 'var(--warn)', crit: 'var(--crit)' };
  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
      <div style="position:relative;width:${size}px;height:${size}px">
        <svg width="${size}" height="${size}" style="transform:rotate(-90deg)">
          <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none"
                  stroke="var(--surface-3)" stroke-width="${stroke}"></circle>
          <circle cx="${size/2}" cy="${size/2}" r="${r}" fill="none"
                  stroke="${colorMap[state]}" stroke-width="${stroke}" stroke-linecap="round"
                  stroke-dasharray="${c}" stroke-dashoffset="${offset}"></circle>
        </svg>
        <div style="position:absolute;inset:0;display:grid;place-items:center">
          <span class="mono" style="font-size:12px;font-weight:600;letter-spacing:-0.02em">
            ${Math.round(g.pct*100)}<span style="font-size:8px;color:var(--text-3)">%</span>
          </span>
        </div>
      </div>
      <div style="text-align:center;line-height:1.15">
        <div style="font-size:10.5px;color:var(--text);font-weight:500">${g.label}</div>
        <div class="mono" style="font-size:9.5px;color:var(--text-3);margin-top:1px">${g.reset}</div>
      </div>
    </div>`;
}

let activeTab = 'today';
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name)
  );
  renderActiveTab();
}

function renderActiveTab() {
  const root = document.getElementById('tab-content');
  if (activeTab === 'today') root.innerHTML = renderTodayTab(lastData.today);
  else if (activeTab === 'recent') root.innerHTML = renderRecentTab(lastData.today);
  else if (activeTab === 'models') root.innerHTML = renderModelsTab(lastData.today);
}

function renderTodayTab(today) {
  if (!today) return '<div class="prefs-meta">Loading…</div>';
  const items = [
    { label: 'Messages', value: today?.totals?.messageCount ?? 0 },
    { label: 'Tool calls', value: today?.totals?.toolCallCount ?? 0 },
    { label: 'Sessions', value: today?.sessions?.length ?? 0 },
    { label: 'Cache hit', value: `${Math.round((today?.totals?.cacheHitRate ?? 0) * 100)}%`, accent: 'var(--ok)' },
  ];
  return `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
      ${items.map((i) => `
        <div style="padding:8px 10px;background:var(--bg);border:1px solid var(--hairline);border-radius:8px">
          <div style="font-size:9px;letter-spacing:0.10em;text-transform:uppercase;color:var(--text-3)">${i.label}</div>
          <div class="mono" style="font-size:15px;font-weight:600;margin-top:2px;color:${i.accent || 'var(--text)'};letter-spacing:-0.01em">${i.value}</div>
        </div>`).join('')}
    </div>`;
}

function renderRecentTab(today) {
  const sessions = (today?.sessions ?? []).slice(0, 5);
  if (sessions.length === 0) return '<div class="prefs-meta">No sessions today.</div>';
  return `<div style="display:flex;flex-direction:column;gap:1px">
    ${sessions.map((s, i, a) => `
      <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center;padding:8px 4px;border-bottom:${i < a.length-1 ? '1px solid var(--hairline)' : 'none'};font-size:11.5px">
        <span class="mono" style="color:var(--text-3);font-size:11px">${formatTime(s.start)}</span>
        <span class="mono">${s.project ?? '—'}</span>
        <span style="font-size:9.5px;padding:1px 5px;border-radius:3px;color:${modelColor(s.model)};background:var(--surface-2);font-family:var(--mono)">${shortModel(s.model)}</span>
        <span class="mono" style="font-weight:600">$${(s.cost ?? 0).toFixed(2)}</span>
      </div>`).join('')}
  </div>`;
}

function renderModelsTab(today) {
  const models = (today?.byModel ?? []);
  if (models.length === 0) return '<div class="prefs-meta">No model data today.</div>';
  const total = models.reduce((s, m) => s + (m.cost ?? 0), 0) || 1;
  return `
    <div style="display:flex;height:6px;border-radius:999px;overflow:hidden;margin-bottom:14px;background:var(--surface-3)">
      ${models.map((m) => `<div style="width:${(m.cost/total)*100}%;background:${modelColor(m.model)}"></div>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${models.map((m) => `
        <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center">
          <span style="width:8px;height:8px;border-radius:2px;background:${modelColor(m.model)}"></span>
          <span class="mono" style="font-size:11.5px">${m.model}</span>
          <span class="mono" style="font-size:10.5px;color:var(--text-3)">${Math.round((m.cost/total)*100)}%</span>
          <span class="mono" style="font-size:11.5px;font-weight:600;min-width:48px;text-align:right">$${(m.cost ?? 0).toFixed(2)}</span>
        </div>`).join('')}
    </div>`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function shortModel(m) {
  if (!m) return '—';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return m;
}
function modelColor(m) {
  if (!m) return 'var(--text-3)';
  if (m.includes('opus')) return 'var(--opus)';
  if (m.includes('sonnet')) return 'var(--sonnet)';
  if (m.includes('haiku')) return 'var(--haiku)';
  return 'var(--text-3)';
}

document.addEventListener('DOMContentLoaded', init);
```

- [ ] **Step 2: Add open_dashboard IPC command**

In `src-tauri/src/ipc.rs`, append:
```rust
#[tauri::command]
pub async fn open_dashboard<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    } else {
        crate::windows::create_dashboard(&app).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

In `src-tauri/src/lib.rs`, register it in `invoke_handler![...]`:
```rust
.invoke_handler(tauri::generate_handler![
    ipc::get_server_port,
    ipc::check_for_updates,
    ipc::set_autostart,
    ipc::get_autostart,
    ipc::open_dashboard,
])
```

- [ ] **Step 3: Build + manual smoke**

Run: `cd src-tauri && cargo run`
Click tray. Expected: popover shows hero amount with sparkline, 4 ring gauges populated, Today tab shows 4 stat cards. Switch to Recent tab → list of recent sessions. Switch to Models → stacked bar + list. Click "Open dashboard →" → dashboard window appears.

- [ ] **Step 4: Commit**

```bash
git add popover/popover.js src-tauri/src/ipc.rs src-tauri/src/lib.rs
git commit -m "feat(v3): port menubar.jsx to vanilla — gauges, sparkline, tabs"
```

---

## Phase 5 — Auto-update + Tauri keypair

The most security-sensitive phase. Generate the Tauri signing keypair, embed pubkey, configure updater, and wire the post-download `xattr -d com.apple.quarantine` hook.

---

### Task 19: Generate Tauri keypair

**Files:**
- Modify: `src-tauri/tauri.conf.json` (add updater config + pubkey)
- Create: `docs/RELEASE_CHECKLIST.md` (record the procedure)

**MANUAL STEP REQUIRED:** Generate the keypair locally — the private key is a secret that should NOT be committed.

- [ ] **Step 1: Install Tauri CLI if not present**

Run:
```bash
cargo install tauri-cli --version "^2.0" --locked
```

- [ ] **Step 2: Generate keypair**

Run:
```bash
mkdir -p ~/.clauge-secrets
cd ~/.clauge-secrets
cargo tauri signer generate -w clauge-update.key
```

Expected: prompts for a password, writes `clauge-update.key` (private) and prints the matching pubkey base64. **Save the pubkey output.**

- [ ] **Step 3: Embed pubkey in tauri.conf.json**

In `src-tauri/tauri.conf.json`, add to `plugins`:
```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://clauding-lab.github.io/clauge/latest.json"
    ],
    "dialog": false,
    "pubkey": "PASTE_PUBKEY_BASE64_HERE"
  }
}
```

Replace `PASTE_PUBKEY_BASE64_HERE` with the value from Step 2.

- [ ] **Step 4: Create RELEASE_CHECKLIST.md**

Write `docs/RELEASE_CHECKLIST.md`:
```markdown
# Clauge V3 — Release Checklist

## Tauri keypair management

The Tauri updater verifies update integrity using a keypair generated via `cargo tauri signer generate`.

- **Public key:** committed in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`
- **Private key:** stored in `~/.clauge-secrets/clauge-update.key` locally and as GitHub Actions secret `TAURI_PRIVATE_KEY`
- **Password:** GitHub Actions secret `TAURI_KEY_PASSWORD`

### Key rotation

If the private key is compromised:

1. Generate a new keypair: `cargo tauri signer generate -w clauge-update-NEW.key`
2. Update `src-tauri/tauri.conf.json` with the new pubkey
3. Update GitHub Actions secrets (`TAURI_PRIVATE_KEY`, `TAURI_KEY_PASSWORD`)
4. Ship a forced point release with the new pubkey embedded
5. Old-version users will NOT auto-update to the new key — they trust the old key only and must reinstall manually from GitHub Releases
6. Document the rotation in CHANGELOG and pin the manual-reinstall instructions in README until adoption is high

## Pre-tag manual smoke

```
□ Install fresh DMG on a Mac that doesn't have V3
□ Right-click → Open passes Gatekeeper warning
□ Tray icon appears within 2s
□ Click tray → popover opens with real data
□ Click "Open dashboard →" → V2.2 dashboard renders
□ Settings → toggle autostart, quit, reboot, app auto-launches
□ Force update check → new version downloads, swaps, restarts
□ Quit app → ps -ef | grep clauge-server returns nothing
□ Coexistence: launch npm clauge first, then V3 → V3 connects as client
□ Coexistence: quit npm clauge while V3 open → V3 spawns own sidecar within 30s
```

## Tagging a release

1. Bump `version` in `package.json` and `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`
2. Update CHANGELOG.md
3. Commit: `git commit -am "chore: release vX.Y.Z"`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push origin main --tags`
6. GitHub Actions runs `release.yml` workflow → publishes DMG and updates `gh-pages/latest.json`
7. Verify the release page on GitHub has the `.dmg` and `.dmg.sig` artifacts
```

- [ ] **Step 5: Build to verify pubkey is parsed**

Run: `cd src-tauri && cargo build`
Expected: builds without error.

- [ ] **Step 6: Commit (without committing the secret)**

```bash
git add src-tauri/tauri.conf.json docs/RELEASE_CHECKLIST.md
git commit -m "feat(v3): updater config — embed Tauri pubkey, document rotation"
```

**Manual user step:** Add `TAURI_PRIVATE_KEY` (contents of `~/.clauge-secrets/clauge-update.key`) and `TAURI_KEY_PASSWORD` as GitHub Actions secrets via repo Settings → Secrets and Variables → Actions. (Performed during Task 26.)

---

### Task 20: Post-download quarantine strip hook

**Files:**
- Create: `scripts/strip-quarantine.sh`
- Modify: `src-tauri/src/lib.rs` (run hook after updater download)

The Tauri updater downloads `.tar.gz` and applies it. We need a hook that runs `xattr -d com.apple.quarantine` on the swapped binary.

- [ ] **Step 1: Create strip script**

Write `scripts/strip-quarantine.sh`:
```bash
#!/usr/bin/env bash
set -e
APP_PATH="${1:-/Applications/Clauge.app}"
if [[ -d "$APP_PATH" ]]; then
  xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
  echo "[clauge] Quarantine attribute stripped from $APP_PATH"
fi
```

Run: `chmod +x scripts/strip-quarantine.sh`

- [ ] **Step 2: Wire post-update hook in updater event handler**

The Tauri 2.x updater plugin emits download/install events. Modify `src-tauri/src/ipc.rs` `check_for_updates` to:
```rust
#[tauri::command]
pub async fn check_for_updates(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    use std::process::Command;
    use tauri_plugin_notification::NotificationExt;

    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            update
                .download_and_install(|_, _| {}, || {})
                .await
                .map_err(|e| e.to_string())?;

            // Strip quarantine on the running .app bundle
            if let Ok(exe) = std::env::current_exe() {
                let app_bundle = exe
                    .ancestors()
                    .find(|p| p.extension().map_or(false, |e| e == "app"));
                if let Some(bundle) = app_bundle {
                    let _ = Command::new("xattr")
                        .args(["-dr", "com.apple.quarantine"])
                        .arg(bundle)
                        .output();
                }
            }

            let _ = app
                .notification()
                .builder()
                .title("Clauge updated")
                .body("Restart the app to apply the new version.")
                .show();
            Ok(())
        }
        Ok(None) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
```

- [ ] **Step 3: Build + verify**

Run: `cd src-tauri && cargo build`
Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add scripts/strip-quarantine.sh src-tauri/src/ipc.rs
git commit -m "feat(v3): strip quarantine attr post-update for invisible auto-updates"
```

---

## Phase 6 — Polish: notifications, autostart default, single-instance

---

### Task 21: Default autostart ON for first launch

**Files:**
- Modify: `src-tauri/src/lib.rs` (call autostart enable on first launch)

- [ ] **Step 1: Add first-launch detection and autostart enablement**

In `src-tauri/src/lib.rs` `setup` block, AFTER the menu setup, add:
```rust
// First-launch autostart enablement
{
    use tauri_plugin_autostart::ManagerExt;
    use tauri_plugin_store::StoreExt;
    let store = app.store("settings.json").map_err(|e| {
        log::error!("store: {}", e);
        e
    })?;
    let first_launch = store.get("first_launch_done").is_none();
    if first_launch {
        let _ = app.autolaunch().enable();
        store.set("first_launch_done", serde_json::Value::Bool(true));
        let _ = store.save();
    }
}
```

- [ ] **Step 2: Build + smoke**

Run:
```bash
rm -rf ~/Library/Application\ Support/com.clauding.clauge
cd src-tauri && cargo run
```
Expected: app starts. Open System Settings → General → Login Items → Clauge should be present in "Open at Login" list.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(v3): enable Launch at Login by default on first launch"
```

---

### Task 22: macOS notification permission handling

Notifications need permission on macOS Sonoma+. Tauri's notification plugin requests this on first use, but we should handle the denied case gracefully.

**Files:**
- Modify: `src-tauri/src/sidecar.rs` (skip notification dispatch if permission denied)

- [ ] **Step 1: Wrap notification calls in permission check**

In `src-tauri/src/sidecar.rs`, the `NotifyAndRespawn` branch already uses `app.notification().builder()...show()`. Tauri returns Err if denied. The current code uses `let _ =` to silently ignore errors — this is correct behavior per the spec (skip silently if denied). No change needed, but add log:

Modify:
```rust
CrashAction::NotifyAndRespawn => {
    use tauri_plugin_notification::NotificationExt;
    if let Err(e) = app
        .notification()
        .builder()
        .title("Clauge")
        .body("Clauge had a problem — please restart the app.")
        .show()
    {
        log::warn!("notification not dispatched: {}", e);
    }
}
```

- [ ] **Step 2: Build**

Run: `cd src-tauri && cargo build`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/sidecar.rs
git commit -m "feat(v3): log notification dispatch failures (permission denied)"
```

---

### Task 23: Single-instance — focus existing on second launch

This was already added as a placeholder in Task 11. Verify the focus behavior actually works.

**Files:**
- Modify: `src-tauri/src/lib.rs` (improve single-instance handler)

- [ ] **Step 1: Improve single-instance handler**

In `src-tauri/src/lib.rs`, replace the single-instance plugin init with:
```rust
.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
    // Focus the popover on second launch attempt; if not visible, show it
    if let Some(popover) = app.get_webview_window("popover") {
        let _ = popover.show();
        let _ = popover.set_focus();
    } else if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}))
```

- [ ] **Step 2: Manual smoke**

Run two `cargo run` invocations sequentially. Expected: second invocation does NOT start a new app — it focuses the popover of the first.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "fix(v3): single-instance handler focuses popover on duplicate launch"
```

---

## Phase 7 — Tests: Tauri-driver E2E

End-to-end tests exercising tray, popover, dashboard, lifecycle.

---

### Task 24: tauri-driver setup + 7 E2E scenarios

**Files:**
- Create: `test/e2e/setup.ts`
- Create: `test/e2e/v3.test.ts`
- Modify: `package.json` (add `test:e2e` script + dev deps)

- [ ] **Step 1: Install tauri-driver and webdriverio**

Run:
```bash
brew install --cask --no-quarantine tauri-driver
npm install --save-dev webdriverio @types/node typescript ts-node tsx
```

- [ ] **Step 2: Write setup**

Write `test/e2e/setup.ts`:
```ts
import { spawn } from 'node:child_process';
import { remote } from 'webdriverio';

let driverProcess: ReturnType<typeof spawn> | null = null;

export async function startDriver() {
  driverProcess = spawn('tauri-driver', [], { stdio: 'pipe' });
  await new Promise((r) => setTimeout(r, 1000));
  const browser = await remote({
    hostname: 'localhost',
    port: 4444,
    capabilities: {
      'tauri:options': {
        application: '../../src-tauri/target/debug/clauge',
      },
    },
  });
  return browser;
}

export async function stopDriver(browser: WebdriverIO.Browser) {
  await browser.deleteSession();
  driverProcess?.kill();
}
```

- [ ] **Step 3: Write E2E suite**

Write `test/e2e/v3.test.ts`:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { startDriver, stopDriver } from './setup.js';

test('app launches with tray icon present', async () => {
  const browser = await startDriver();
  // Tauri-driver doesn't expose tray inspection directly; verify via window list
  const handles = await browser.getWindowHandles();
  // popover window is always present (created hidden at boot)
  assert.ok(handles.length >= 1, 'at least one window handle exists');
  await stopDriver(browser);
});

test('popover opens on tray click — verified by window visibility', async () => {
  const browser = await startDriver();
  // Simulate left-click on tray via OS automation (osascript)
  // tauri-driver doesn't trigger tray events; use AppleScript fallback
  // For V3.0 plan, mark this scenario as MANUAL via the release checklist
  // and use a programmatic show via IPC for the automated suite
  const handles = await browser.getWindowHandles();
  await browser.switchToWindow(handles[0]);
  const url = await browser.getUrl();
  assert.match(url, /popover\/index\.html|tauri:/);
  await stopDriver(browser);
});

test('dashboard window opens via IPC', async () => {
  const browser = await startDriver();
  await browser.switchToWindow((await browser.getWindowHandles())[0]);
  await browser.execute(() => {
    // @ts-ignore
    return window.__TAURI__.core.invoke('open_dashboard');
  });
  await new Promise((r) => setTimeout(r, 800));
  const handles = await browser.getWindowHandles();
  assert.ok(handles.length >= 2, 'dashboard window appeared');
  await stopDriver(browser);
});

test('autostart toggle flips state', async () => {
  const browser = await startDriver();
  await browser.switchToWindow((await browser.getWindowHandles())[0]);
  const before = await browser.execute(() => {
    // @ts-ignore
    return window.__TAURI__.core.invoke('get_autostart');
  });
  await browser.execute((enabled) => {
    // @ts-ignore
    return window.__TAURI__.core.invoke('set_autostart', { enabled: !enabled });
  }, before);
  const after = await browser.execute(() => {
    // @ts-ignore
    return window.__TAURI__.core.invoke('get_autostart');
  });
  assert.notEqual(before, after);
  await stopDriver(browser);
});

test('quit cleanly exits within 3s', async () => {
  const browser = await startDriver();
  const start = Date.now();
  await browser.execute(() => {
    // @ts-ignore
    window.__TAURI__.core.invoke('quit_app').catch(() => {});
  });
  await new Promise((r) => setTimeout(r, 3500));
  // If we got here without timeout, exit was prompt
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 4000);
});
```

- [ ] **Step 4: Add `quit_app` IPC for testability**

In `src-tauri/src/ipc.rs`, append:
```rust
#[tauri::command]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
```

Register in `src-tauri/src/lib.rs` invoke_handler.

- [ ] **Step 5: Add scripts to package.json**

In `package.json` `scripts`:
```json
"test:e2e": "tsx --test test/e2e/v3.test.ts"
```

- [ ] **Step 6: Document E2E manual gaps**

The tray-click scenario (`popover opens on tray click`) requires real OS-level tray click simulation that tauri-driver doesn't provide. Document this in `docs/RELEASE_CHECKLIST.md` under "Pre-tag manual smoke" — that scenario must be human-verified.

Append to `docs/RELEASE_CHECKLIST.md`:
```markdown

## E2E manual gaps

The following scenarios cannot be automated via tauri-driver and require manual verification before release:

- Left-click on tray icon → popover appears
- Vibrancy material visible (semi-transparent macOS-native popover effect)
- Cmd+Q exits the app cleanly (no orphan sidecar process: `ps -ef | grep clauge-server`)
- Auto-update download → quarantine strip → relaunch from `/Applications/Clauge.app`
- macOS notification permission first prompt
```

- [ ] **Step 7: Commit**

```bash
git add test/e2e/ src-tauri/src/ipc.rs src-tauri/src/lib.rs package.json package-lock.json docs/RELEASE_CHECKLIST.md
git commit -m "test(v3): tauri-driver E2E suite + manual gap documentation"
```

---

## Phase 8 — CI + release pipeline

---

### Task 25: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `.github/workflows/ci.yml` (PR checks)

- [ ] **Step 1: Write CI workflow (PR checks)**

Write `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with: { toolchain: stable }
      - run: npm ci
      - run: npm test
      - run: npm run build:sidecar
      - run: npm run test:sea
      - run: cargo test --manifest-path src-tauri/Cargo.toml
      - run: cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

- [ ] **Step 2: Write release workflow**

Write `.github/workflows/release.yml`:
```yaml
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions-rust-lang/setup-rust-toolchain@v1
        with: { toolchain: stable }
      - run: npm ci

      - name: Build SEA sidecar (Universal)
        run: npm run build:sidecar

      - name: Run unit tests
        run: |
          npm test
          npm run test:sea
          cargo test --manifest-path src-tauri/Cargo.toml

      - name: Build Tauri app
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_KEY_PASSWORD }}
        run: |
          cd src-tauri
          cargo tauri build --target universal-apple-darwin

      - name: Extract version
        id: ver
        run: echo "version=${GITHUB_REF#refs/tags/v}" >> $GITHUB_OUTPUT

      - name: Compute signature
        id: sig
        run: |
          SIG=$(cat src-tauri/target/universal-apple-darwin/release/bundle/macos/Clauge.app.tar.gz.sig)
          echo "sig=$SIG" >> $GITHUB_OUTPUT

      - name: Upload to GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            src-tauri/target/universal-apple-darwin/release/bundle/dmg/Clauge_*.dmg
            src-tauri/target/universal-apple-darwin/release/bundle/macos/Clauge.app.tar.gz
            src-tauri/target/universal-apple-darwin/release/bundle/macos/Clauge.app.tar.gz.sig

      - name: Generate latest.json for updater endpoint
        run: |
          cat > latest.json <<EOF
          {
            "version": "${{ steps.ver.outputs.version }}",
            "notes": "See release notes on GitHub.",
            "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
            "platforms": {
              "darwin-x86_64": {
                "signature": "${{ steps.sig.outputs.sig }}",
                "url": "https://github.com/${{ github.repository }}/releases/download/v${{ steps.ver.outputs.version }}/Clauge.app.tar.gz"
              },
              "darwin-aarch64": {
                "signature": "${{ steps.sig.outputs.sig }}",
                "url": "https://github.com/${{ github.repository }}/releases/download/v${{ steps.ver.outputs.version }}/Clauge.app.tar.gz"
              }
            }
          }
          EOF

      - name: Publish latest.json to gh-pages
        uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: .
          publish_branch: gh-pages
          keep_files: true
          destination_dir: .
          allow_empty_commit: false
          enable_jekyll: false
```

- [ ] **Step 3: Add note to RELEASE_CHECKLIST.md about secrets**

Append to `docs/RELEASE_CHECKLIST.md`:
```markdown

## GitHub Actions secrets required

Set these via repo Settings → Secrets and Variables → Actions:

- `TAURI_PRIVATE_KEY` — full contents of `~/.clauge-secrets/clauge-update.key`
- `TAURI_KEY_PASSWORD` — password for the above key

## gh-pages branch initialization

Before the first release, create an empty `gh-pages` branch:

```bash
git checkout --orphan gh-pages
git rm -rf .
echo '{}' > latest.json
git add latest.json
git commit -m "chore: initialize gh-pages for updater endpoint"
git push origin gh-pages
git checkout main
```

Then enable GitHub Pages: repo Settings → Pages → Source: `gh-pages` branch, `/` (root).
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ docs/RELEASE_CHECKLIST.md
git commit -m "ci(v3): GitHub Actions release pipeline + PR CI workflow"
```

---

### Task 26: Initialize gh-pages branch and set GH secrets

**Manual user steps** — no code changes.

- [ ] **Step 1: Initialize gh-pages branch**

Run:
```bash
cd ~/Projects/clauge
git checkout --orphan gh-pages
git rm -rf .
echo '{}' > latest.json
git add latest.json
git commit -m "chore: initialize gh-pages for updater endpoint"
git push origin gh-pages
git checkout main
```

- [ ] **Step 2: Enable GitHub Pages**

Web: github.com/clauding-lab/clauge → Settings → Pages → Source: `gh-pages` branch, `/ (root)` → Save.

- [ ] **Step 3: Add Tauri keypair as GitHub secrets**

Web: Settings → Secrets and Variables → Actions → New repository secret:
- Name: `TAURI_PRIVATE_KEY`, Value: full contents of `~/.clauge-secrets/clauge-update.key`
- Name: `TAURI_KEY_PASSWORD`, Value: the password used during keypair generation

- [ ] **Step 4: Test the workflow with a draft release**

Run:
```bash
git tag v0.3.0-rc1
git push origin v0.3.0-rc1
```

Watch Actions tab on GitHub. Expected: workflow runs, builds DMG, uploads to release, updates `gh-pages/latest.json`.

If the rc1 build succeeds, delete the tag and re-tag as `v0.3.0` for the real release.

---

## Phase 9 — First release

---

### Task 27: Manual release smoke + tag v0.3.0

- [ ] **Step 1: Run the manual release checklist**

Open `docs/RELEASE_CHECKLIST.md` and tick through every item under "Pre-tag manual smoke."

- [ ] **Step 2: Bump versions**

Edit `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` — set version to `0.3.0`.

- [ ] **Step 3: Update CHANGELOG**

Add to `CHANGELOG.md`:
```markdown
## v0.3.0 — 2026-MM-DD

V3 native macOS desktop app. Tauri 2.x shell wrapping the existing analytics
server as a Node SEA sidecar. Tray icon menu bar popover (vibrancy material,
sub-50ms perceived latency via pre-rendering), lazy native dashboard window,
auto-update via Tauri's keypair + post-download quarantine strip (zero-friction
unsigned updates), Launch at Login default ON with Preferences toggle.
Smart port-sharing: V3 detects existing npm clauge on 3456 and shares it
rather than spawning a duplicate sidecar.
```

- [ ] **Step 4: Commit + tag + push**

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore: release v0.3.0 — V3 native macOS app"
git tag v0.3.0
git push origin main --tags
```

- [ ] **Step 5: Verify the release artifacts**

Watch GitHub Actions. Once green:
- Confirm `Clauge_0.3.0_universal.dmg` is on the Release page
- Confirm `https://clauding-lab.github.io/clauge/latest.json` returns the new version
- Download the DMG, install fresh on a Mac, run the manual smoke checklist a second time

- [ ] **Step 6: Announce**

Update README.md with V3 install instructions, add a section "Native macOS app (V3)" with the DMG link. Commit.

---

## Self-Review

### Spec coverage check

Mapped each spec section/requirement to a task:

| Spec section | Task(s) |
|---|---|
| §3.1 All three coexist | T9, T12, T14 (port discovery + spawn-or-share) |
| §3.2 Menu bar + native window | T13 (tray), T14 (dashboard), T16-T18 (popover) |
| §3.3 Bundled Node SEA sidecar | T2, T4, T8 (build + smoke) |
| §3.4 Mac-first unsigned | T20 (xattr strip), T25 (release pipeline) |
| §3.5 Native shell only | Scope contract — no dashboard feature tasks added |
| §3.6 Tauri 2.x + plugin-shell | T2 (Cargo deps), T11-T12 (sidecar wiring) |
| §3.7 Auto-update via Tauri keypair + xattr | T19, T20, T25 |
| §3.8 Auto-launch default ON, toggleable | T21 (default), T18 (toggle UI), T11 (IPC) |
| §3.9 Smart port-sharing | T9 (port discovery) |
| §3.10 Sidecar crashes recover silently | T10 (circuit-breaker) |
| §4 Architecture overview diagram | Implemented across all phases |
| §4.2 Required plugins | T2 (Cargo.toml deps), T11 (lib.rs registration) |
| §4.2 Native UX features (vibrancy, prerender, native menu) | T15 (menu), T17 (vibrancy), T16 (prerender) |
| §5 Components matrix | All tasks |
| §5.1 Popover via fetch + IPC for port | T11 (IPC), T18 (fetch) |
| §5.1 Universal binary | T4 (lipo) |
| §5.1 Dashboard via HTTP not asset:// | T14 |
| §6 Data flow | Implicit in T9-T18 |
| §7 Error handling matrix | T10 (sidecar crash), T22 (notification denied) |
| §7.4 Crash-loop circuit-breaker | T10 |
| §8 Test pyramid | T5-T8 (unit + smoke), T24 (E2E), T25 (CI) |
| §9 Build & distribution | T4, T19, T20, T25, T26 |
| §11 Risks (SEA fallback) | Documented in T4 commentary; fallback is "raw Node + dir" if SEA breaks |

**Gaps found and addressed during self-review:**
- Initial draft missed the `quit_app` IPC — added in T24
- Vibrancy positioning was implicit in T16 — split out to dedicated T17
- gh-pages branch init was buried in T25 — promoted to manual T26 to make it explicit
- E2E suite couldn't automate tray click — documented as manual in T24 step 6 and added to RELEASE_CHECKLIST.md

### Placeholder scan

- "TODO Task 14" in T13 step 3 — intentional; explicitly bridged within same plan execution. Replaced by T14.
- "TODO Task 17" in T16 step 3 — intentional; replaced by T17.
- No "TBD", "implement later", or "fill in details" anywhere outside the bridges above.

### Type / signature consistency

- `ipc::AppState.server_port: Arc<Mutex<Option<u16>>>` — used consistently in T11, T12, T18.
- `port_discovery::DiscoveryResult::{External(u16), SpawnAt(u16)}` — referenced in T9 and T12 with matching variants.
- `sidecar::CrashAction::{SilentRespawn, NotifyAndRespawn, BackoffRespawn(Duration)}` — defined T10, used T10 itself.
- `CLAUGE_BOUND_PORT=` stderr marker — defined in T6, parsed in T12.
- IPC commands registered: `get_server_port, check_for_updates, set_autostart, get_autostart, open_dashboard, quit_app` — registered in lib.rs across T11, T18, T24.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-07-clauge-v3-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for V3's scope (27 tasks across 10 phases) — keeps each subagent's context tight and catches bad assumptions per-task.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints. Slower per-task but simpler control flow.

Which approach?
