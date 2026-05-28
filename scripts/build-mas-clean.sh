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
#   ./scripts/build-mas-clean.sh             # production build (signed PKG for Transporter)
#   ./scripts/build-mas-clean.sh --local-test # launchable .app for local sandbox testing
#                                            # (uses real cert but stripped entitlements +
#                                            #  removes embedded.provisionprofile so macOS
#                                            #  doesn't reject the Production-only profile
#                                            #  for direct launch)
#
# Output:
#   Production:  /tmp/Clauge-MAS-<VERSION>.pkg
#   Local-test:  re-signed .app at $APP_PATH (path printed at end)
#
# Why local-test mode exists: a MAS-built .app signed with a Production
# provisioning profile cannot be double-clicked on the dev machine — macOS
# refuses to install Production profiles for direct launch (it accepts only
# Development profiles for that). To verify the sandbox-runtime behavior
# (wizard race fix + sidecar entitlement fix) before paying the round-trip
# cost of a Transporter upload + Apple Review, the script strips restricted
# entitlements and removes the embedded profile. The sandbox still activates
# at runtime because app-sandbox stays in the entitlements; the
# Production-specific restrictions are simply skipped.
set -euo pipefail

MODE="production"
# Backward-compatible alias: --ad-hoc was the original (misleading) name for
# the same flow; new name is --local-test. Accept both.
if [[ "${1:-}" == "--local-test" || "${1:-}" == "--ad-hoc" ]]; then
  MODE="local-test"
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

# Always use the real Apple Developer cert. Ad-hoc signing (identity="-")
# was tried during v0.9.10 sandbox-test work and rejected by AMFI with code
# -424 ("file is adhoc signed but contains restricted entitlements"): the
# main app's `com.apple.application-identifier` + `team-identifier` keys
# require a real cert + matching provisioning profile, even just to launch.
# So the cert is needed regardless of mode; what changes between modes is
# the ENTITLEMENTS file used for the main app (full vs stripped) and
# whether we keep the embedded provisioning profile.
SIGN_IDENTITY="$APP_CERT_SHA1"

# Main-app entitlements file: production uses the full file with restricted
# keys + keeps embedded.provisionprofile; local-test uses the stripped
# variant and removes the profile so macOS doesn't reject the Production
# profile for direct launch.
if [[ "$MODE" == "production" ]]; then
  MAIN_ENTITLEMENTS="$SRC_TAURI/entitlements.mas.plist"
else
  MAIN_ENTITLEMENTS="$SRC_TAURI/entitlements.local-test.plist"
  if [[ -f "$APP_PATH/Contents/embedded.provisionprofile" ]]; then
    echo "==> Removing embedded.provisionprofile (rejected for direct launch in local-test mode)..."
    rm -f "$APP_PATH/Contents/embedded.provisionprofile"
  fi
fi

echo "==> Re-signing sidecar with sidecar entitlements (no app-id, no app-sandbox)..."
# v0.9.10 (Apple Issue 2 actual root cause): entitlements-sidecar.mas.plist
# no longer declares com.apple.security.app-sandbox — the sidecar inherits
# the parent's sandbox via process tree. Standalone Mach-O binaries without
# embedded Info.plist crash during libsystem_secinit's per-binary container
# setup if they declare app-sandbox themselves. See AGENT_LEARNINGS.md.
codesign --force --options runtime \
  --entitlements "$SRC_TAURI/entitlements-sidecar.mas.plist" \
  --sign "$SIGN_IDENTITY" \
  "$SIDECAR_PATH"

echo "==> Re-signing main .app bundle (entitlements=$(basename "$MAIN_ENTITLEMENTS"))..."
codesign --force --options runtime \
  --entitlements "$MAIN_ENTITLEMENTS" \
  --sign "$SIGN_IDENTITY" \
  "$APP_PATH"

echo "==> Verifying signatures..."
codesign --verify --deep --strict "$APP_PATH"
echo "Main app entitlements (should include application-identifier in production):"
# Trailing `|| true` because grep returning no matches exits 1, which `set -e`
# + pipefail (at the top of this script) would interpret as a fatal error
# and kill the script silently before reaching productbuild. The grep is
# diagnostic-only — we want to PRINT whatever it matches, not gate the
# build on the result.
codesign -d --entitlements - --xml "$APP_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10 || true
echo "Sidecar entitlements (should NOT include application-identifier):"
# This grep correctly returns NO matches (sidecar deliberately omits all
# three of those keys per the v0.9.10 fix), so `|| true` is load-bearing
# here — without it the script silently dies before productbuild and you
# get a re-signed .app but no .pkg. See AGENT_LEARNINGS.md 2026-05-28.
codesign -d --entitlements - --xml "$SIDECAR_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10 || true
echo "  (empty match above on the sidecar is correct: app-sandbox + restricted entitlements are intentionally absent)"

if [[ "$MODE" == "local-test" ]]; then
  echo
  echo "==> DONE (local-test mode). Re-signed .app at:"
  echo "    $APP_PATH"
  echo
  echo "    To verify the sandbox-runtime behavior before Transporter upload:"
  echo "      1. (Optional) Stop any production Clauge first:"
  echo "           pkill -TERM -f '/Applications/Clauge.app/Contents/MacOS/clauge'"
  echo "      2. (Optional) Reset the sandbox container for a true fresh-launch state:"
  echo "           rm -rf ~/Library/Containers/com.clauding.clauge"
  echo "      3. Launch the local-test .app directly:"
  echo "           open $APP_PATH"
  echo "      4. Observe — within ~1–8 seconds the welcome wizard should appear"
  echo "         WITH visible content (heading 'Welcome to Clauge', step 1 body)."
  echo "      5. Click Grant Access → NSOpenPanel opens → pick your real ~/.claude/."
  echo "         The bookmark persists; sidecar respawns with CLAUDE_DIR populated."
  echo "      6. Walk through wizard steps; the dashboard should populate from data."
  echo "      7. Quit and relaunch — the wizard should NOT reappear (bookmark"
  echo "         persisted in the sandbox container)."
  echo
  echo "    Console diagnostic predicates (Console.app or 'log show'):"
  echo "      process == 'clauge' OR process == 'clauge-server'"
  echo "    Watch for:"
  echo "      - 'CLAUGE_BOUND_PORT=' (sidecar bound, sidecar-ready about to fire)"
  echo "      - 'Welcome to Clauge' window-open event (~1-8 s post-launch)"
  echo "      - any 'Sandbox: ... deny' lines (would indicate a remaining issue)"
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
