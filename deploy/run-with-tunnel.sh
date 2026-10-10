#!/usr/bin/env bash
# Run the SethuCMS gateway on this computer with its state in Firestore, and
# give it a public HTTPS address through a free Cloudflare Tunnel (no card).
#
#   bash deploy/run-with-tunnel.sh              # random https://....trycloudflare.com address
#   bash deploy/run-with-tunnel.sh my-tunnel    # your own name, after the one-time setup below
#
# Needs: the built gateway (cd apps/api && pnpm build), `cloudflared`
# (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/),
# and the Firestore service-account key at ~/.config/sethucms/firestore-key.json.
#
# The gateway secrets are made once and kept in ~/.config/sethucms/gateway.env
# (mode 600, outside the repository). Keep the vault key in a password manager:
# without it, saved database passwords cannot be decrypted.
#
# Status: written and syntax-checked; run it once yourself before the demo.
# A free tunnel works only while this computer is on and online.
#
# For your own name (cms.example.com) the domain must be on Cloudflare DNS:
#   cloudflared tunnel login
#   cloudflared tunnel create my-tunnel
#   cloudflared tunnel route dns my-tunnel cms.example.com
# then run this script with: my-tunnel cms.example.com
set -euo pipefail

CONF_DIR="${HOME}/.config/sethucms"
KEY="${CONF_DIR}/firestore-key.json"
ENV_FILE="${CONF_DIR}/gateway.env"
PORT="${PORT:-8099}"
PROJECT="${SETHUCMS_FIRESTORE_PROJECT:-sethucms-fd902}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="${HERE}/apps/api"

[ -f "${API}/dist/src/main.js" ] || { echo "Build first: cd apps/api && pnpm build" >&2; exit 1; }
[ -f "${KEY}" ] || { echo "Missing ${KEY}" >&2; exit 1; }
command -v cloudflared >/dev/null || { echo "Install cloudflared first (see the link at the top of this script)." >&2; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed to make secrets." >&2; exit 1; }

mkdir -p "${CONF_DIR}"; chmod 700 "${CONF_DIR}"
if [ ! -f "${ENV_FILE}" ]; then
  umask 077
  {
    echo "SETHUCMS_VAULT_KEY=$(openssl rand -base64 32)"
    echo "SETHUCMS_CURSOR_SECRET=$(openssl rand -base64 32)"
    echo "SETHUCMS_PREVIEW_SECRET=$(openssl rand -base64 32)"
    echo "SETHUCMS_ADMIN_TOKEN=$(openssl rand -hex 32)"
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "Made ${ENV_FILE}."
  echo "Copy SETHUCMS_VAULT_KEY from it into your password manager now."
fi
set -a; . "${ENV_FILE}"; set +a

cleanup() { [ -n "${GW_PID:-}" ] && kill "${GW_PID}" 2>/dev/null && wait "${GW_PID}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "Port ${PORT} is busy. Stop the other process or set PORT=<other>." >&2; exit 1
fi

cd "${API}"
NODE_ENV=production HOST=127.0.0.1 PORT="${PORT}" SETHUCMS_DATA_DIR=memory \
SETHUCMS_TRUST_PROXY=true \
SETHUCMS_FIRESTORE_PROJECT="${PROJECT}" \
SETHUCMS_FIRESTORE_CREDENTIALS_JSON="$(cat "${KEY}")" \
node dist/src/main.js &
GW_PID=$!

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:${PORT}/v1/health" >/dev/null 2>&1 && break
  kill -0 "${GW_PID}" 2>/dev/null || { echo "The gateway stopped; see the message above." >&2; exit 1; }
  sleep 0.5
done
curl -fsS "http://127.0.0.1:${PORT}/v1/health" >/dev/null || { echo "Gateway did not become healthy." >&2; exit 1; }
echo "Gateway is healthy on http://127.0.0.1:${PORT}. Admin token: grep SETHUCMS_ADMIN_TOKEN ${ENV_FILE}"

if [ "${1:-}" != "" ]; then
  exec_args=(tunnel run --url "http://127.0.0.1:${PORT}" "$1")
  echo "Public address: https://${2:-<the name you routed>}"
  cloudflared "${exec_args[@]}"
else
  echo "Look for the https://....trycloudflare.com address below."
  cloudflared tunnel --url "http://127.0.0.1:${PORT}"
fi
