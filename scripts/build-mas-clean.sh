#!/usr/bin/env bash
# Build the MAS .app + .pkg with split entitlements (main vs helper).
#
# The sidecar (clauge-server, Node SEA) is wrapped in its OWN .app bundle at
# Contents/Helpers/Clauge Helper.app/. This is the Apple-documented
# architecture for sandboxed bundled helpers (Electron + Chromium use the
# same pattern). Without the helper.app wrap:
#   - Transporter rejects with HTTP 409 "App sandbox not enabled" if the
#     standalone Mach-O at Contents/MacOS/clauge-server lacks
#     com.apple.security.app-sandbox.
#   - libsystem_secinit's _libsecinit_appsandbox SIGTRAPs at runtime if
#     the standalone Mach-O DECLARES app-sandbox but has no embedded
#     Info.plist providing CFBundleIdentifier (cd83087 mid-cycle attempt
#     in v0.9.10).
# The helper.app gives the binary its own Info.plist with
# CFBundleIdentifier=com.clauding.clauge.helper so libsystem_secinit can
# set up the helper's per-binary container at runtime, AND it satisfies
# Transporter's "every Mach-O must have app-sandbox" rule statically.
#
# Pipeline:
#   1. Tauri build — signs every binary with entitlements.mas.plist (default).
#   2. Wrap clauge-server in Contents/Helpers/Clauge Helper.app/:
#      generate Info.plist; move binary from Contents/MacOS/ to
#      Contents/Helpers/Clauge Helper.app/Contents/MacOS/.
#   3. Re-sign helper binary with entitlements-sidecar.mas.plist
#      (NO application-identifier, NO team-identifier; app-sandbox=true
#      now valid via the helper's bundle Info.plist).
#   4. Sign the helper.app bundle to seal it (re-uses the helper-binary
#      entitlements; no --deep so the binary's signature is preserved).
#   5. Re-sign main .app to re-seal the bundle (picks up new helper sig).
#   6. productbuild + productsign with installer cert.
#
# Inside-out order matters: codesign seals each bundle. If we sign the
# main bundle first then the helper, the main bundle's seal becomes
# invalid. By signing the helper binary → helper bundle → main bundle in
# that order, each outer seal includes the fresh inner signature.
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
# After Tauri build, the SEA binary initially lives at this path (Tauri's
# externalBin default). The helper-wrap step below moves it into its own
# .app bundle so libsystem_secinit can find a CFBundleIdentifier at runtime
# AND Transporter's "every Mach-O must have app-sandbox" check passes.
TAURI_SIDECAR_PATH="$APP_PATH/Contents/MacOS/clauge-server"
HELPER_APP_PATH="$APP_PATH/Contents/Helpers/Clauge Helper.app"
HELPER_BINARY_PATH="$HELPER_APP_PATH/Contents/MacOS/clauge-server"

# Derive version from package.json so the PKG filename auto-updates on each
# version bump. jq is installed on Adnan's Mac (he uses it routinely); falls
# back to a node one-liner if not.
if command -v jq >/dev/null 2>&1; then
  VERSION="$(jq -r .version "$REPO_ROOT/package.json")"
else
  VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
fi
MAS_BUNDLE_VERSION=$(jq -r '.bundle.macOS.bundleVersion' "$REPO_ROOT/src-tauri/tauri.mas.conf.json")
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

echo "==> Wrapping clauge-server in Contents/Helpers/Clauge Helper.app/..."
# Defensive cleanup in case a prior partial run left a stale helper bundle
# (cargo tauri build doesn't manage Helpers/, so we own the lifecycle here).
rm -rf "$HELPER_APP_PATH"
mkdir -p "$HELPER_APP_PATH/Contents/MacOS"
mkdir -p "$HELPER_APP_PATH/Contents/Resources"

# Generate the helper bundle's Info.plist BEFORE moving the binary. The
# critical field is CFBundleIdentifier — without it, libsystem_secinit's
# _libsecinit_appsandbox SIGTRAPs at runtime when the binary launches
# (it can't determine which sandbox container to bind to). Other fields:
#   - CFBundleExecutable=clauge-server: tells launchd what binary to run
#     when the bundle is invoked. Tauri's manual std::process::Command
#     spawn in src/sidecar.rs hits the binary path directly, so this is
#     mostly for plistutil / Finder metadata consistency.
#   - CFBundlePackageType=APPL: matches what Electron/Chromium use for
#     helper apps (vs BNDL which is for loadable plug-ins).
#   - LSUIElement=true + LSBackgroundOnly=true: no Dock icon, no menu bar,
#     not in Cmd+Tab. Helper runs invisible to the user.
#   - CFBundleVersion=4 must match tauri.mas.conf.json::bundle.macOS.
#     bundleVersion (Apple's monotonic build counter for CFBundleVersion).
#   - CFBundleShortVersionString: matches package.json $VERSION.
#   - LSMinimumSystemVersion=12.0: matches main app's
#     tauri.conf.json::bundle.macOS.minimumSystemVersion.
cat > "$HELPER_APP_PATH/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.clauding.clauge.helper</string>
    <key>CFBundleExecutable</key>
    <string>clauge-server</string>
    <key>CFBundleName</key>
    <string>Clauge Helper</string>
    <key>CFBundleDisplayName</key>
    <string>Clauge Helper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>CFBundleVersion</key>
    <string>${MAS_BUNDLE_VERSION}</string>
    <key>CFBundleShortVersionString</key>
    <string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSBackgroundOnly</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright © 2026 Adnan Rashid. All rights reserved.</string>
</dict>
</plist>
PLIST

# Move the Tauri-built binary into the helper bundle. Tauri's
# bundle.externalBin still drops it at Contents/MacOS/clauge-server during
# the build; we relocate it post-build because Tauri 2 has no API to
# customize the output path of externalBin entries. The runtime spawn
# path in src-tauri/src/sidecar.rs (MAS branch) constructs the new
# absolute path from the bundle root.
mv "$TAURI_SIDECAR_PATH" "$HELPER_BINARY_PATH"

echo "==> Helper bundle layout:"
ls -la "$HELPER_APP_PATH/Contents/"
echo

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

# v0.9.10 build 5: declare exempt encryption so App Store Connect skips the
# export-compliance dialog. Clauge uses only standard HTTPS/TLS (reqwest/rustls
# + the Node sidecar's TLS) — exempt under Apple/BIS rules — so the paperwork-
# free declaration is ITSAppUsesNonExemptEncryption=false. This ALSO re-includes
# France/EU with no encryption-declaration document upload. Injected into the
# main app's Tauri-generated Info.plist BEFORE the main .app is signed (the
# codesign step below seals Info.plist; modifying it afterward would invalidate
# the signature). Idempotent (Delete-then-Add). See AGENTS.md landmine #27 item 1.
echo "==> Setting ITSAppUsesNonExemptEncryption=false in main Info.plist..."
/usr/libexec/PlistBuddy -c "Delete :ITSAppUsesNonExemptEncryption" "$APP_PATH/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$APP_PATH/Contents/Info.plist"

echo "==> Signing helper.app bundle (sidecar entitlements; app-sandbox=true now valid via helper Info.plist)..."
# Inside-out signing: codesign on a bundle applies --entitlements to the
# bundle's CFBundleExecutable (clauge-server) AND seals the bundle into
# Contents/_CodeSignature/CodeResources. The main .app bundle is signed
# afterward so its own CodeResources picks up the helper's fresh signature.
#
# Sidecar entitlements omit application-identifier + team-identifier to
# avoid Transporter 90885 (nested executable profile mismatch); the helper
# has no per-binary provisioning profile. app-sandbox=true is now valid
# because the helper.app's Info.plist provides CFBundleIdentifier so
# libsystem_secinit can set up the helper's per-binary sandbox container
# at runtime (vs. the cd83087 mid-cycle attempt where the standalone
# binary at Contents/MacOS/clauge-server SIGTRAPped during dyld init).
codesign --force --options runtime \
  --entitlements "$SRC_TAURI/entitlements-sidecar.mas.plist" \
  --sign "$SIGN_IDENTITY" \
  "$HELPER_APP_PATH"

echo "==> Re-signing main .app bundle (entitlements=$(basename "$MAIN_ENTITLEMENTS"))..."
# No --deep on the outer sign: --deep would re-sign nested code (the
# helper.app's binary) with the MAIN entitlements, clobbering the helper's
# fresh sidecar entitlements. Without --deep, codesign signs the main
# bundle's CFBundleExecutable (clauge) with main entitlements and rebuilds
# the bundle's CodeResources, which seals the helper.app digest-wise but
# does not touch its signature.
codesign --force --options runtime \
  --entitlements "$MAIN_ENTITLEMENTS" \
  --sign "$SIGN_IDENTITY" \
  "$APP_PATH"

echo "==> Verifying signatures..."
codesign --verify --deep --strict "$APP_PATH"
codesign --verify --deep --strict "$HELPER_APP_PATH"
echo "Main app entitlements (should include application-identifier + app-sandbox in production):"
# Trailing `|| true` because grep returning no matches exits 1, which `set -e`
# + pipefail (at the top of this script) would interpret as a fatal error
# and kill the script silently before reaching productbuild. The grep is
# diagnostic-only — we want to PRINT whatever it matches, not gate the
# build on the result. See AGENT_LEARNINGS.md 2026-05-28.
codesign -d --entitlements - --xml "$APP_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10 || true
echo "Helper bundle entitlements (should include app-sandbox; should NOT include application-identifier):"
codesign -d --entitlements - --xml "$HELPER_APP_PATH" 2>/dev/null | plutil -convert xml1 -o - - | grep -E "application-identifier|team-identifier|app-sandbox" | head -10 || true
echo "Helper bundle Info.plist sanity (CFBundleIdentifier + CFBundleExecutable + LSUIElement):"
plutil -p "$HELPER_APP_PATH/Contents/Info.plist" | grep -E "CFBundleIdentifier|CFBundleExecutable|LSUIElement" || true

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
echo "    Then in App Store Connect, attach build $VERSION (CFBundleVersion $(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist" 2>/dev/null)) to the"
echo "    existing submission 32193453-1524-407a-b705-c16ae62fbbd3 and resubmit."
