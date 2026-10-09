#!/bin/sh
# Start the gateway and the admin app on http://127.0.0.1:8080 for local use.
# Data (saved connections, drafts, audit log) is kept in ./.sethucms-data
# Stop with Ctrl+C.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PARENT=$(dirname "$ROOT")

if [ ! -f "$ROOT/apps/api/dist/src/main.js" ]; then
  echo "The gateway is not built yet. Run:  sh scripts/build-all.sh" >&2
  exit 1
fi
if [ ! -f "$PARENT/sethucms-admin/dist/index.html" ]; then
  echo "The admin app is not built yet. Run:  sh scripts/build-all.sh" >&2
  exit 1
fi

export SETHUCMS_ADMIN_DIR="${SETHUCMS_ADMIN_DIR:-$PARENT/sethucms-admin/dist}"
export SETHUCMS_DATA_DIR="${SETHUCMS_DATA_DIR:-$ROOT/.sethucms-data}"
export PORT="${PORT:-8080}"

cd "$ROOT/apps/api"
exec node dist/src/main.js
