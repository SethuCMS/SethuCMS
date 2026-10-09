#!/bin/sh
# Make a compressed copy of the gateway's data folder.
#
#   sh scripts/backup.sh [data-folder] [output-folder]
#
# Defaults: $SETHUCMS_DATA_DIR (or ./.sethucms-data) and ./backups.
#
# STOP THE GATEWAY FIRST, or run this on a snapshot. The gateway writes its state
# in files; copying while it writes can give a copy that does not open.
# The vault key is NOT in the folder in production: back it up separately.
# The backup holds encrypted connection passwords, token hashes and the audit log.
# Treat it like a secret.
set -eu

DATA="${1:-${SETHUCMS_DATA_DIR:-./.sethucms-data}}"
OUT="${2:-./backups}"

[ -d "$DATA" ] || { echo "No data folder at $DATA" >&2; exit 1; }

if [ -f "$DATA/gateway.lock" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$DATA/gateway.lock" 2>/dev/null || stat -f %m "$DATA/gateway.lock") ))
  if [ "$AGE" -lt 30 ]; then
    echo "A gateway seems to be running (lock refreshed ${AGE}s ago). Stop it first." >&2
    exit 1
  fi
fi

umask 077
mkdir -p "$OUT"
FILE="$OUT/sethucms-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
# The lock file is not part of the data.
tar -C "$(dirname "$DATA")" --exclude='gateway.lock' -czf "$FILE" "$(basename "$DATA")"
echo "Wrote $FILE"
echo "Restore: stop the gateway, then  tar -C <parent-folder> -xzf $FILE"
