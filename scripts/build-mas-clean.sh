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
set -euo pipefail

WORKTREE="/Users/adnanrashid/conductor/workspaces/clauge/mas-implement-session"
SRC_TAURI="$WORKTREE/src-tauri"
APP_PATH="$SRC_TAURI/target/universal-apple-darwin/release/bundle/macos/Clauge.app"
SIDECAR_PATH="$APP_PATH/Contents/MacOS/clauge-server"
APP_CERT_SHA1="8E2186661CBDCC424149F713A16A430FB024DC7C"
INSTALLER_CERT_SHA1="33F6A1C91A77DCCE51405445B77A96D445B1FE82"
PKG_OUT="/tmp/Clauge-MAS-0.9.0.pkg"
PKG_UNSIGNED="/tmp/Clauge-MAS-0.9.0-unsigned.pkg"

echo "==> Tauri build (signs everything with entitlements.mas.plist)..."
cd "$SRC_TAURI"
PATH="/Users/adnanrashid/.nvm/versions/node/v22.22.2/bin:$PATH" \
  cargo tauri build --features mas --config tauri.mas.conf.json \
    --bundles app --target universal-apple-darwin

echo "==> Re-signing sidecar with sidecar entitlements (no app-id)..."
codesign --force --options runtime \
  --entitlements "$SRC_TAURI/entitlements-sidecar.mas.plist" \
  --sign "$APP_CERT_SHA1" \
  "$SIDECAR_PATH"

echo "==> Re-signing main .app bundle to re-seal..."
codesign --force --options runtime \
  --entitlements "$SRC_TAURI/entitlements.mas.plist" \
  --sign "$APP_CERT_SHA1" \
  "$APP_PATH"

echo "==> Verifying signatures..."
codesign --verify --deep --strict "$APP_PATH"
echo "Main app entitlements (should include application-identifier):"
codesign -d --entitlements - --xml "$APP_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10
echo "Sidecar entitlements (should NOT include application-identifier):"
codesign -d --entitlements - --xml "$SIDECAR_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10

echo "==> productbuild..."
rm -f "$PKG_OUT" "$PKG_UNSIGNED" 2>/dev/null || true
productbuild --component "$APP_PATH" /Applications "$PKG_UNSIGNED"

echo "==> productsign with installer cert..."
productsign --sign "$INSTALLER_CERT_SHA1" "$PKG_UNSIGNED" "$PKG_OUT"

echo "==> Verifying pkg signature..."
pkgutil --check-signature "$PKG_OUT" | head -10
ls -la "$PKG_OUT"

echo "==> DONE. .pkg at $PKG_OUT"
