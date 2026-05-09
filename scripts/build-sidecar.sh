#!/usr/bin/env bash
set -euo pipefail

# Builds clauge-server as a Universal (arm64 + x86_64) Node SEA binary.
# Output: src-tauri/binaries/clauge-server-aarch64-apple-darwin
# Output: src-tauri/binaries/clauge-server-x86_64-apple-darwin
# Output: src-tauri/binaries/clauge-server-universal-apple-darwin (lipo-merged)

START=$SECONDS

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DIST="$REPO_ROOT/dist"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
mkdir -p "$DIST" "$BIN_DIR"

# 0. Copy popover/* into public/popover/* so the SEA's wildcard
#    serveStatic('/*', root: 'public') route serves the native NSPopover's
#    WKWebView content (loaded as http://127.0.0.1:{port}/popover/index.html).
#    Done at build time so the SEA blob includes everything in public/.
echo "[build-sidecar] Copying popover assets into public/popover/..."
mkdir -p "$REPO_ROOT/public/popover"
cp "$REPO_ROOT/popover/"*.html "$REPO_ROOT/public/popover/"
cp "$REPO_ROOT/popover/"*.css "$REPO_ROOT/public/popover/"
cp "$REPO_ROOT/popover/"*.js "$REPO_ROOT/public/popover/"
if [ -d "$REPO_ROOT/popover/fonts" ]; then
  cp -r "$REPO_ROOT/popover/fonts" "$REPO_ROOT/public/popover/"
fi

# 1. Bundle server.js + lib/ into a single ESM file.
# server.js uses top-level await and import.meta — ESM is the only viable bundle format.
# The CJS bootstrap (scripts/sea-bootstrap.cjs) extracts the bundle from SEA assets
# at startup and dynamic-imports it, because Node SEA's main entry is loaded as CJS.
#
# Banner: esbuild's __require shim needs a real `require`/`__filename`/`__dirname`
# when CJS sub-deps (dotenv, etc.) are pulled into an ESM bundle. createRequire
# from node:module gives us that.
echo "[build-sidecar] Bundling server + lib into ESM..."
npx esbuild server.js \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --banner:js="import { createRequire as __seaCreateRequire } from 'node:module'; const require = __seaCreateRequire(import.meta.url);" \
  --outfile="$DIST/server.bundle.mjs"

# 2. Build the SEA blob (architecture-independent — same JS for all archs)
echo "[build-sidecar] Generating SEA blob..."
node --experimental-sea-config scripts/sea-config.json

# 3. Helper: inject blob into a node binary for a given arch
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

# 4. Determine current node arch
CURRENT_ARCH=$(node -e "console.log(process.arch)")
CURRENT_NODE=$(command -v node)

if [[ "$CURRENT_ARCH" == "arm64" ]]; then
  inject_sea "arm64" "aarch64-apple-darwin" "$CURRENT_NODE"
else
  inject_sea "x86_64" "x86_64-apple-darwin" "$CURRENT_NODE"
fi

# 5. For the OTHER arch, download the matching node tarball
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
curl -fSL "$OTHER_URL" -o "$TMP_DIR/$OTHER_TARBALL" || {
  echo "[build-sidecar] FATAL: failed to download $OTHER_URL" >&2
  exit 1
}

# Verify SHA256 against nodejs.org's published SHASUMS256.txt.  Without this
# check, a nodejs.org compromise, DNS-level MITM, or simple tarball corruption
# could inject arbitrary Node bytes into the universal SEA sidecar that ships
# inside the SIGNED DMG.  Fast (one extra HTTP fetch + a single shasum), and
# fail-loud if mismatch.
SHASUMS_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
echo "[build-sidecar] Verifying SHA256 against $SHASUMS_URL..."
curl -fSL "$SHASUMS_URL" -o "$TMP_DIR/SHASUMS256.txt" || {
  echo "[build-sidecar] FATAL: failed to download $SHASUMS_URL" >&2
  exit 1
}
( cd "$TMP_DIR" && grep "  ${OTHER_TARBALL}\$" SHASUMS256.txt | shasum -a 256 -c - ) || {
  echo "[build-sidecar] FATAL: SHA256 mismatch for $OTHER_TARBALL — possible tarball tampering or nodejs.org issue" >&2
  exit 1
}
echo "[build-sidecar] SHA256 verified."

tar -xzf "$TMP_DIR/$OTHER_TARBALL" -C "$TMP_DIR"
OTHER_NODE="$TMP_DIR/node-v${NODE_VERSION}-darwin-${OTHER_ARCH}/bin/node"

inject_sea "$OTHER_ARCH" "$OTHER_TRIPLE" "$OTHER_NODE"

# 6. lipo-merge the two per-arch SEA binaries into a single universal fat
# binary.  Tauri 2.x's bundler, when invoked with --target universal-apple-darwin,
# copies `binaries/clauge-server-universal-apple-darwin` into the .app — it does
# NOT auto-merge per-arch binaries at bundle time, so we must produce the
# universal here.  Per-arch binaries stay in place for non-universal builds.
echo "[build-sidecar] lipo-merging arm64 + x86_64 into universal binary..."
UNIVERSAL_OUT="$BIN_DIR/clauge-server-universal-apple-darwin"
lipo -create \
  "$BIN_DIR/clauge-server-aarch64-apple-darwin" \
  "$BIN_DIR/clauge-server-x86_64-apple-darwin" \
  -output "$UNIVERSAL_OUT"
chmod +x "$UNIVERSAL_OUT"
codesign --remove-signature "$UNIVERSAL_OUT" || true
codesign --sign - --force --preserve-metadata=entitlements,requirements,flags,runtime "$UNIVERSAL_OUT"
echo "[build-sidecar] Built $UNIVERSAL_OUT"

# 7. Cleanup blob + intermediate bundle
rm -f sea-prep.blob "$DIST/server.bundle.mjs"

ELAPSED=$((SECONDS - START))
echo "[build-sidecar] Done in ${ELAPSED}s. Universal SEA binaries in $BIN_DIR"
ls -lh "$BIN_DIR"
