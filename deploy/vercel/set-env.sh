#!/usr/bin/env bash
# Put the gateway's settings into the Vercel project, from the files that
# deploy/run-with-tunnel.sh made on this computer:
#   ~/.config/sethucms/gateway.env        (vault key, cursor and preview secrets, admin token)
#   ~/.config/sethucms/firestore-key.json (Google service-account key)
#
# Run it inside deploy/vercel/out after `npx vercel link`:
#   bash ../set-env.sh
#
# Values go to Vercel through stdin (never on a command line or in shell
# history) and are stored as Sensitive: Vercel cannot show them again. Keep
# gateway.env as your own copy, and keep SETHUCMS_VAULT_KEY in a password
# manager: without it, saved database passwords cannot be decrypted.
#
# Status: written; run `npx vercel env add --help` first if a flag is refused,
# since the Vercel CLI changes its flags now and then.
set -euo pipefail

CONF="${HOME}/.config/sethucms"
ENV_FILE="${CONF}/gateway.env"
KEY="${CONF}/firestore-key.json"
PROJECT="${SETHUCMS_FIRESTORE_PROJECT:-sethucms-fd902}"
PREFIX="${SETHUCMS_FIRESTORE_PREFIX:-sethucms}"

[ -f "${ENV_FILE}" ] || { echo "Missing ${ENV_FILE}. Run deploy/run-with-tunnel.sh once to create it." >&2; exit 1; }
[ -f "${KEY}" ] || { echo "Missing ${KEY}" >&2; exit 1; }
[ -f vercel.json ] || { echo "Run this inside deploy/vercel/out." >&2; exit 1; }
[ -d .vercel ] || { echo "Run 'npx vercel link' here first." >&2; exit 1; }

set -a; . "${ENV_FILE}"; set +a

add() { # name value [--no-sensitive]
  printf '%s' "$2" | npx vercel env add "$1" production "${3:---sensitive}" --force --yes >/dev/null
  echo "set $1"
}

add SETHUCMS_VAULT_KEY "${SETHUCMS_VAULT_KEY}"
add SETHUCMS_CURSOR_SECRET "${SETHUCMS_CURSOR_SECRET}"
add SETHUCMS_PREVIEW_SECRET "${SETHUCMS_PREVIEW_SECRET}"
add SETHUCMS_ADMIN_TOKEN "${SETHUCMS_ADMIN_TOKEN}"
add SETHUCMS_FIRESTORE_CREDENTIALS_JSON "$(cat "${KEY}")"
add SETHUCMS_FIRESTORE_PROJECT "${PROJECT}" --no-sensitive
add SETHUCMS_FIRESTORE_PREFIX "${PREFIX}" --no-sensitive
add SETHUCMS_SERVERLESS "1" --no-sensitive
add SETHUCMS_DATA_DIR "memory" --no-sensitive
add SETHUCMS_TRUST_PROXY "true" --no-sensitive
echo "Done. Deploy with: npx vercel deploy --prod"
