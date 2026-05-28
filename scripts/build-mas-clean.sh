#!/usr/bin/env bash
# Build the MAS .app + .pkg with split entitlements (main vs sidecar).
# Resolves Transporter 90885 (nested executable mismatch) by re-signing
# the sidecar with entitlements that omit application-identifier.
#
# Pipeline:
#   1. Tauri build — signs every binary with entitlements.mas.plist (default).
#   2. Re-sign sidecar (clauge-server) with entitlements-sidecar.mas.plist
#      (NO application-identifier, NO team-identifier).
#   3. Re-sign main .app to re-seal the bundle (picks up new sidecar sig).
#   4. productbuild + productsign with installer cert.
#
# Inside-out order matters: codesign seals the bundle. If we sign the bundle
# first then the sidecar, the bundle seal becomes invalid. By signing the
# sidecar first and the bundle last, the bundle's seal includes the sidecar's
# new signature.
#
# Usage:
#   ./scripts/build-mas-clean.sh          # production build (signed PKG for Transporter)
#   ./scripts/build-mas-clean.sh --ad-hoc # ad-hoc-signed .app for local sandbox testing
#                                         # (no cert needed; skips productbuild + productsign)
#
# Output:
#   Production: /tmp/Clauge-MAS-<VERSION>.pkg
#   Ad-hoc:     ad-hoc signed .app at $APP_PATH (path printed at end)
set -euo pipefail

MODE="production"
if [[ "${1:-}" == "--ad-hoc" ]]; then
  MODE="ad-hoc"
fi

# Resolve repo root from the script's own location so this works regardless
# of where the user invokes it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_TAURI="$REPO_ROOT/src-tauri"
APP_PATH="$SRC_TAURI/target/universal-apple-darwin/release/bundle/macos/Clauge.app"
SIDECAR_PATH="$APP_PATH/Contents/MacOS/clauge-server"

# Derive version from package.json so the PKG filename auto-updates on each
# version bump. jq is installed on Adnan's Mac (he uses it routinely); falls
# back to a node one-liner if not.
if command -v jq >/dev/null 2>&1; then
  VERSION="$(jq -r .version "$REPO_ROOT/package.json")"
else
  VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
fi
PKG_OUT="/tmp/Clauge-MAS-${VERSION}.pkg"
PKG_UNSIGNED="/tmp/Clauge-MAS-${VERSION}-unsigned.pkg"

# Apple Developer certs. SHA1s are stable across enrollment renewals; only
# change if Apple revokes + reissues a cert (per AGENT_LEARNINGS 2026-05-17
# entry, "switch signingIdentity to next SHA1 — D97B was revoked by Apple").
# Verify these still exist in your Keychain before running production mode:
#   security find-identity -v -p codesigning
APP_CERT_SHA1="8E2186661CBDCC424149F713A16A430FB024DC7C"
INSTALLER_CERT_SHA1="33F6A1C91A77DCCE51405445B77A96D445B1FE82"

# Node PATH override — needed when cargo tauri spawns scripts/build-sidecar.mjs
# which relies on Node 22 features (SEA). Adnan uses nvm; only prepend this if
# the path actually exists, so the script doesn't break on a clean reinstall
# or on a machine using Homebrew Node instead.
NODE_NVM_PATH="/Users/adnanrashid/.nvm/versions/node/v22.22.2/bin"
if [[ -d "$NODE_NVM_PATH" ]]; then
  export PATH="$NODE_NVM_PATH:$PATH"
fi

# Sanity checks before doing real work.
if [[ "$MODE" == "production" ]]; then
  if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$APP_CERT_SHA1"; then
    echo "==> ERROR: App cert $APP_CERT_SHA1 not found in Keychain." >&2
    echo "    Run: security find-identity -v -p codesigning" >&2
    echo "    Then update APP_CERT_SHA1 in this script to the active cert." >&2
    echo "    Or rerun with --ad-hoc to skip cert-dependent signing." >&2
    exit 1
  fi
  if ! security find-identity -v -p basic 2>/dev/null | grep -q "$INSTALLER_CERT_SHA1"; then
    echo "==> ERROR: Installer cert $INSTALLER_CERT_SHA1 not found in Keychain." >&2
    echo "    Run: security find-identity -v -p basic" >&2
    echo "    Then update INSTALLER_CERT_SHA1 in this script." >&2
    exit 1
  fi
fi

for plist in "$SRC_TAURI/entitlements.mas.plist" "$SRC_TAURI/entitlements-sidecar.mas.plist"; do
  if [[ ! -f "$plist" ]]; then
    echo "==> ERROR: Missing entitlements file: $plist" >&2
    exit 1
  fi
done

echo "==> Build mode: $MODE"
echo "==> Repo root: $REPO_ROOT"
echo "==> Version: $VERSION"
echo

echo "==> Tauri build (signs everything with entitlements.mas.plist)..."
cd "$SRC_TAURI"
cargo tauri build --features mas --config tauri.mas.conf.json \
  --bundles app --target universal-apple-darwin

# Pick the signing identity for the re-sign steps. Production uses the real
# Apple Developer cert; ad-hoc uses "-" (the codesign convention for an
# ad-hoc / unsigned-but-with-entitlements signature, which is enough to
# activate the App Sandbox at runtime locally).
if [[ "$MODE" == "production" ]]; then
  SIGN_IDENTITY="$APP_CERT_SHA1"
else
  SIGN_IDENTITY="-"
fi

echo "==> Re-signing sidecar with sidecar entitlements (no app-id; identity=$SIGN_IDENTITY)..."
codesign --force --options runtime \
  --entitlements "$SRC_TAURI/entitlements-sidecar.mas.plist" \
  --sign "$SIGN_IDENTITY" \
  "$SIDECAR_PATH"

echo "==> Re-signing main .app bundle to re-seal..."
codesign --force --options runtime \
  --entitlements "$SRC_TAURI/entitlements.mas.plist" \
  --sign "$SIGN_IDENTITY" \
  "$APP_PATH"

echo "==> Verifying signatures..."
codesign --verify --deep --strict "$APP_PATH"
echo "Main app entitlements (should include application-identifier in production):"
codesign -d --entitlements - --xml "$APP_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10
echo "Sidecar entitlements (should NOT include application-identifier):"
codesign -d --entitlements - --xml "$SIDECAR_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10

if [[ "$MODE" == "ad-hoc" ]]; then
  echo
  echo "==> DONE (ad-hoc mode). Ad-hoc-signed .app at:"
  echo "    $APP_PATH"
  echo
  echo "    To test the wizard race fix in sandbox-equivalent context:"
  echo "      1. Create a fresh macOS user account (System Settings → Users & Groups → +),"
  echo "         OR temporarily move ~/.claude/ aside to simulate a clean install."
  echo "      2. Copy $APP_PATH into /Applications/ in that account."
  echo "      3. Launch from /Applications/Clauge.app. Observe:"
  echo "           - Welcome wizard window appears WITH content (not blank)"
  echo "           - Click Grant Access → NSOpenPanel opens → pick ~/.claude/"
  echo "           - Dashboard populates with usage data"
  echo "      4. Quit, relaunch. Wizard should NOT reappear (bookmark persisted)."
  echo "      5. Console.app — predicate \"process == 'Clauge'\" — should show no"
  echo "         sandbox denials on ~/.claude/.credentials.json reads."
  exit 0
fi

echo "==> productbuild..."
rm -f "$PKG_OUT" "$PKG_UNSIGNED" 2>/dev/null || true
productbuild --component "$APP_PATH" /Applications "$PKG_UNSIGNED"

echo "==> productsign with installer cert..."
productsign --sign "$INSTALLER_CERT_SHA1" "$PKG_UNSIGNED" "$PKG_OUT"

echo "==> Verifying pkg signature..."
pkgutil --check-signature "$PKG_OUT" | head -10
ls -la "$PKG_OUT"

echo
echo "==> DONE. .pkg at $PKG_OUT"
echo "    Next: open Transporter.app, drag the .pkg in, click Deliver."
echo "    Then in App Store Connect, attach build $VERSION (CFBundleVersion 4) to the"
echo "    existing submission 32193453-1524-407a-b705-c16ae62fbbd3 and resubmit."
