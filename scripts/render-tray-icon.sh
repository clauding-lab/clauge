#!/usr/bin/env bash
# Render the macOS tray icon from the canonical brand SVG.
#
# Source: public/clauge-menubar-18px.svg — the 18×18 brand mark (gauge with
# brand orange arc + steel-blue inner ring + needle).
#
# Output:
#   src-tauri/icons/tray-icon.png      — 22×22 (1× base)
#   src-tauri/icons/tray-icon@2x.png   — 44×44 (Retina, future use)
#
# Note: Tauri's `Image::from_bytes(include_bytes!(...))` only loads ONE file
# at compile time, so tray.rs continues using `tray-icon.png` (22×22). The
# @2x file ships for completeness; macOS will fall back to scaling the 22×22
# at the moment.
#
# Pipeline: macOS `sips` is the only universal SVG → PNG renderer we rely on
# (no librsvg, Inkscape, or Pillow assumed). To produce a proper TEMPLATE
# icon (macOS expects RGB to be ignored — only alpha matters; tinting is
# auto-applied based on menu bar appearance), we first emit a monochrome
# variant of the SVG with all stroke/fill colors flattened to black while
# keeping opacities. The `tray.rs` `icon_as_template(true)` flag then makes
# macOS auto-tint white-on-dark / black-on-light.
#
# v0.4.0 change: replaces scripts/render-tray-icon.py (Pillow-based
# programmatic render) with a renderer driven by the canonical SVG.
# Geometry now comes from the brand mark, not from imperative code.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/public/clauge-menubar-18px.svg"
OUT="$ROOT/src-tauri/icons"

if [[ ! -f "$SRC" ]]; then
  echo "ERROR: source SVG not found: $SRC" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "ERROR: sips not found (only available on macOS)" >&2
  exit 1
fi

mkdir -p "$OUT"

# Build the monochrome variant in a temp file. We replace every `stroke="..."`
# and `fill="..."` (other than fill="none") with the black equivalent. The
# opacity / stroke-opacity attributes are left in place so the alpha channel
# carries the visual hierarchy macOS uses for the template tint.
#
# v0.4.0 fixup (T39): the previous `TMP="$(mktemp -t clauge-tray-mono).svg"`
# leaked a tempfile every run — `mktemp -t` on macOS BSD treats its argument
# as a *prefix only* and creates `/var/folders/.../clauge-tray-mono.XXXX`,
# then the shell appends `.svg` to a separate (never-created) path. The
# original tempfile was orphaned each run.
#
# Cross-platform fix: create a tempdir (mktemp -d works identically on BSD
# and GNU), put the .svg inside it. The trap recursively removes the dir,
# so neither the dir nor the inner file is left behind. sips needs the .svg
# extension to recognize the source format — that requirement is what made
# the simple `-t prefix.svg` form impossible.
TMPDIR_LOCAL="$(mktemp -d -t clauge-tray-mono.XXXXXX)"
trap 'rm -rf "$TMPDIR_LOCAL"' EXIT
TMP="$TMPDIR_LOCAL/mono.svg"

# sed flags: -E for extended regex; the substitutions are explicit per-color
# rather than a generic `stroke="#[a-f0-9]+"` blanket because we want to keep
# the safety of being able to exclude `fill="none"` from the rewrite.
sed -E '
  s/stroke="#d97757"/stroke="#000000"/g;
  s/stroke="#6a9bcc"/stroke="#000000"/g;
  s/stroke="#faf9f5"/stroke="#000000"/g;
  s/fill="#faf9f5"/fill="#000000"/g;
' "$SRC" > "$TMP"

# Render at 22×22 and 44×44. sips writes the requested size verbatim; PNG
# alpha is preserved.
sips -s format png -z 22 22 "$TMP" --out "$OUT/tray-icon.png" >/dev/null
sips -s format png -z 44 44 "$TMP" --out "$OUT/tray-icon@2x.png" >/dev/null

# Surface the result so CI / a future committer can verify by reading stdout.
ls -la "$OUT/tray-icon.png" "$OUT/tray-icon@2x.png"

echo "rendered tray icons from $SRC"
