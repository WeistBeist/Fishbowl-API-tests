#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org and run this script again."
  exit 1
fi
echo "Leave this window open while you use the report."
echo "Opening http://127.0.0.1:${REPORT_PORT:-8787}/"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:${REPORT_PORT:-8787}/" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:${REPORT_PORT:-8787}/" || true
fi
exec node server.js
