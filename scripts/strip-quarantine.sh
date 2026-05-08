#!/usr/bin/env bash
set -e
APP_PATH="${1:-/Applications/Clauge.app}"
if [[ -d "$APP_PATH" ]]; then
  xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
  echo "[clauge] Quarantine attribute stripped from $APP_PATH"
fi
