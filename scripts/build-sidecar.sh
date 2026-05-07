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
curl -sL "$OTHER_URL" -o "$TMP_DIR/$OTHER_TARBALL"
tar -xzf "$TMP_DIR/$OTHER_TARBALL" -C "$TMP_DIR"
OTHER_NODE="$TMP_DIR/node-v${NODE_VERSION}-darwin-${OTHER_ARCH}/bin/node"

inject_sea "$OTHER_ARCH" "$OTHER_TRIPLE" "$OTHER_NODE"

# 6. Cleanup blob
rm -f sea-prep.blob

echo "[build-sidecar] Done. Universal SEA binaries in $BIN_DIR"
ls -lh "$BIN_DIR"
