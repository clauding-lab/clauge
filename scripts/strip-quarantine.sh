#!/usr/bin/env bash
set -e
APP_PATH="${1:-/Applications/Clauge.app}"
if [[ ! -d "$APP_PATH" ]]; then
  echo "[clauge] $APP_PATH not found" >&2
  exit 1
fi
if xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null; then
  echo "[clauge] Quarantine attribute stripped from $APP_PATH"
else
  rc=$?
  echo "[clauge] xattr failed (rc=$rc); Gatekeeper may still flag $APP_PATH" >&2
  exit $rc
fi
