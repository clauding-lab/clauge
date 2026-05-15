#!/usr/bin/env node
// Cross-platform SEA builder for clauge-server.
//
// macOS: produces three binaries — arm64, x86_64, and a lipo-merged universal —
//   matching the prior build-sidecar.sh behavior byte-for-functional-equivalent.
//   Downloads the other-arch Node tarball from nodejs.org with SHA256 verify.
//
// Windows: produces one binary — clauge-server-x86_64-pc-windows-msvc.exe —
//   using the host's local node.exe + postject (no codesign, no lipo).
//
// Linux: out of scope — exits with an error.

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, copyFileSync, copyFileSync as _copy,
  rmSync, readdirSync, statSync, createReadStream, createWriteStream,
  readFileSync, writeFileSync, chmodSync,
} from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const DIST = join(REPO_ROOT, 'dist');
const BIN_DIR = join(REPO_ROOT, 'src-tauri', 'binaries');
const SEA_BLOB = join(REPO_ROOT, 'sea-prep.blob');
const BUNDLE = join(DIST, 'server.bundle.mjs');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const startMs = Date.now();

function log(msg) { console.log(`[build-sidecar] ${msg}`); }
function fatal(msg) { console.error(`[build-sidecar] FATAL: ${msg}`); process.exit(1); }

// Windows note: Node refuses to spawn .cmd/.bat files directly after
// CVE-2024-27980; npx, npm, where, etc. are .cmd shims on Windows. Setting
// shell: true on win32 routes the spawn through cmd.exe (which knows how to
// resolve PATH-installed .cmd shims). Node escapes argv arrays correctly for
// cmd.exe under shell: true, so callers don't need to manually quote.
// POSIX builds keep shell: false to preserve the bash-spawn semantics that
// were verified locally on macOS.
const SHELL_ON_WIN = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    shell: SHELL_ON_WIN,
    ...opts,
  });
  if (result.status !== 0) {
    fatal(`${cmd} ${args.join(' ')} exited with status ${result.status}`);
  }
  return result;
}

function runCapture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    shell: SHELL_ON_WIN,
    ...opts,
  });
  if (result.status !== 0) {
    fatal(`${cmd} ${args.join(' ')} failed: ${result.stderr || ''}`);
  }
  return result.stdout.trim();
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

// 0. Copy popover/* into public/popover/* so the SEA's wildcard
//    serveStatic('/*', root: 'public') route can serve the popover content.
function copyPopoverAssets() {
  log('Copying popover assets into public/popover/...');
  const popDst = join(REPO_ROOT, 'public', 'popover');
  mkdirSync(popDst, { recursive: true });
  const popSrc = join(REPO_ROOT, 'popover');
  for (const f of readdirSync(popSrc)) {
    const src = join(popSrc, f);
    const dst = join(popDst, f);
    const st = statSync(src);
    if (st.isDirectory() && f === 'fonts') {
      copyDir(src, dst);
    } else if (st.isFile() && /\.(html|css|js)$/.test(f)) {
      copyFileSync(src, dst);
    }
  }
}

// 1. Bundle server.js + lib/ into a single ESM file.
function bundleServer() {
  log('Bundling server + lib into ESM...');
  mkdirSync(DIST, { recursive: true });
  const banner = "import { createRequire as __seaCreateRequire } from 'node:module'; const require = __seaCreateRequire(import.meta.url);";
  run('npx', [
    'esbuild', 'server.js',
    '--bundle',
    '--platform=node',
    '--target=node22',
    '--format=esm',
    `--banner:js=${banner}`,
    `--outfile=${BUNDLE}`,
  ]);
}

// 2. Build the SEA blob (architecture-independent).
function generateSeaBlob() {
  log('Generating SEA blob...');
  run('node', ['--experimental-sea-config', 'scripts/sea-config.json']);
}

// 3. Inject SEA blob into a Node binary copy. Per-platform postject args.
function injectSea({ srcNode, outPath, codesign }) {
  copyFileSync(srcNode, outPath);
  if (codesign) {
    // Strip any existing signature (codesign refuses to re-inject otherwise).
    spawnSync('codesign', ['--remove-signature', outPath], { stdio: 'inherit' });
  }

  const postjectArgs = [
    'postject', outPath, 'NODE_SEA_BLOB', 'sea-prep.blob',
    '--sentinel-fuse', SENTINEL,
  ];
  if (process.platform === 'darwin') {
    postjectArgs.push('--macho-segment-name', 'NODE_SEA');
  }
  run('npx', postjectArgs);

  if (process.platform !== 'win32') {
    chmodSync(outPath, 0o755);
  }

  if (codesign) {
    // Re-sign ad-hoc so macOS allows execution.
    run('codesign', [
      '--sign', '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      outPath,
    ]);
  }
  log(`Built ${outPath}`);
}

// 4a. macOS branch: arm64 + x86_64 + lipo-merge into universal.
async function buildMacOSUniversal() {
  const currentArch = runCapture('node', ['-e', 'console.log(process.arch)']); // 'arm64' | 'x64'
  const currentNode = runCapture(process.platform === 'win32' ? 'where' : 'which', ['node']).split('\n')[0];

  // Map current arch → target triple.
  const currentMap = {
    arm64: 'aarch64-apple-darwin',
    x64: 'x86_64-apple-darwin',
  };
  if (!(currentArch in currentMap)) fatal(`Unsupported macOS arch: ${currentArch}`);

  // Inject for the current arch using the local Node binary.
  injectSea({
    srcNode: currentNode,
    outPath: join(BIN_DIR, `clauge-server-${currentMap[currentArch]}`),
    codesign: true,
  });

  // Other arch: download from nodejs.org with SHA256 verify, then inject.
  const otherArchTarball = currentArch === 'arm64' ? 'x64' : 'arm64';
  const otherTriple = currentArch === 'arm64'
    ? 'x86_64-apple-darwin'
    : 'aarch64-apple-darwin';

  const nodeVersion = runCapture('node', ['--version']).replace(/^v/, '');
  const tarballName = `node-v${nodeVersion}-darwin-${otherArchTarball}.tar.gz`;
  const tarballUrl = `https://nodejs.org/dist/v${nodeVersion}/${tarballName}`;
  const shasumsUrl = `https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`;

  const tmpDir = join(tmpdir(), `clauge-build-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  log(`Downloading node v${nodeVersion} for ${otherArchTarball}...`);
  await downloadFile(tarballUrl, join(tmpDir, tarballName));

  log(`Verifying SHA256 against ${shasumsUrl}...`);
  await downloadFile(shasumsUrl, join(tmpDir, 'SHASUMS256.txt'));
  verifySha256(join(tmpDir, tarballName), join(tmpDir, 'SHASUMS256.txt'), tarballName);
  log('SHA256 verified.');

  run('tar', ['-xzf', join(tmpDir, tarballName), '-C', tmpDir]);
  const otherNodePath = join(tmpDir, `node-v${nodeVersion}-darwin-${otherArchTarball}`, 'bin', 'node');

  injectSea({
    srcNode: otherNodePath,
    outPath: join(BIN_DIR, `clauge-server-${otherTriple}`),
    codesign: true,
  });

  // Cleanup tmp tarball dir.
  rmSync(tmpDir, { recursive: true, force: true });

  // lipo-merge the two per-arch binaries.
  log('lipo-merging arm64 + x86_64 into universal binary...');
  const universalOut = join(BIN_DIR, 'clauge-server-universal-apple-darwin');
  run('lipo', [
    '-create',
    join(BIN_DIR, 'clauge-server-aarch64-apple-darwin'),
    join(BIN_DIR, 'clauge-server-x86_64-apple-darwin'),
    '-output', universalOut,
  ]);
  chmodSync(universalOut, 0o755);
  spawnSync('codesign', ['--remove-signature', universalOut], { stdio: 'inherit' });
  run('codesign', [
    '--sign', '-',
    '--force',
    '--preserve-metadata=entitlements,requirements,flags,runtime',
    universalOut,
  ]);
  log(`Built ${universalOut}`);
}

// 4b. Windows branch: single x64 binary.
function buildWindowsX64() {
  const currentNode = runCapture('where', ['node']).split('\n')[0]
    .replace(/\r$/, '');

  injectSea({
    srcNode: currentNode,
    outPath: join(BIN_DIR, 'clauge-server-x86_64-pc-windows-msvc.exe'),
    codesign: false,
  });
}

// Helpers: HTTP fetch (no curl on Windows by default) + SHA256 verify.
async function downloadFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) fatal(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(outPath, buf);
}

function verifySha256(filePath, shasumsPath, filename) {
  const shasums = readFileSync(shasumsPath, 'utf8');
  const line = shasums.split('\n').find(l => l.endsWith(`  ${filename}`));
  if (!line) fatal(`no SHASUMS entry for ${filename}`);
  const expected = line.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
  if (expected !== actual) {
    fatal(`SHA256 mismatch for ${filename}: expected ${expected}, got ${actual}`);
  }
}

// Main.
async function main() {
  mkdirSync(DIST, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });

  copyPopoverAssets();
  bundleServer();
  generateSeaBlob();

  if (process.platform === 'darwin') {
    await buildMacOSUniversal();
  } else if (process.platform === 'win32') {
    buildWindowsX64();
  } else {
    fatal(`Unsupported platform: ${process.platform}. Supported: darwin, win32.`);
  }

  // Cleanup intermediate artifacts.
  if (existsSync(SEA_BLOB)) rmSync(SEA_BLOB);
  if (existsSync(BUNDLE)) rmSync(BUNDLE);

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  log(`Done in ${elapsed}s. Sidecar binaries in ${BIN_DIR}`);
  for (const f of readdirSync(BIN_DIR)) {
    const sz = statSync(join(BIN_DIR, f)).size;
    log(`  ${f}  (${(sz / 1024 / 1024).toFixed(1)} MB)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
