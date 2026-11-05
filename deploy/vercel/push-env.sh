#!/usr/bin/env bash
# Sends the settings in local.env to the "out" Vercel project (production).
#   cd deploy/vercel && bash push-env.sh [path/to/file.env]
# Then deploy: cd out && npx vercel deploy --prod   (or run the "Deploy gateway" workflow).
# Values go through stdin, never a command line. The workspace secret is stored as Sensitive.
set -euo pipefail
cd "$(dirname "$0")"
FILE="${1:-local.env}"
[ -f "$FILE" ] || { echo "Missing $FILE" >&2; exit 1; }
[ -d out/.vercel ] || { echo "Run build.mjs, then 'npx vercel link' inside out/ first." >&2; exit 1; }
cd out

add() { # name value sensitivity-flag
  printf '%s' "$2" | npx vercel env add "$1" production "$3" --force --yes >/dev/null
  echo "set $1"
}

secret_set=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  name="${line%%=*}"; value="${line#*=}"
  [ -n "$value" ] || continue
  if [ "$name" = SETHUCMS_WORKSPACE_SECRET ]; then
    add "$name" "$value" --sensitive; secret_set=1
  else
    add "$name" "$value" --no-sensitive
  fi
done < "../$FILE"

# Never replace an existing secret by accident: workspaces are tied to it.
if [ "$secret_set" = 0 ] && npx vercel env ls production 2>/dev/null | grep -q SETHUCMS_WORKSPACE_SECRET; then
  echo "SETHUCMS_WORKSPACE_SECRET already exists on Vercel; left as it is."
elif [ "$secret_set" = 0 ]; then
  add SETHUCMS_WORKSPACE_SECRET "$(openssl rand -hex 32)" --sensitive
  echo "(created a new SETHUCMS_WORKSPACE_SECRET; Vercel will not show it again)"
fi
echo "Done. Deploy to apply: cd out && npx vercel deploy --prod"
