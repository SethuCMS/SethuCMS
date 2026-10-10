#!/usr/bin/env bash
# Installs SethuCMS on ONE server (Ubuntu/Debian with Docker + the compose plugin).
# Run it from a clone of the sethucms repository, as a user who can run docker:
#
#   bash deploy/install-server.sh cms.example.com 0.1.0
#
#   arg 1  the domain (its DNS A/AAAA record must already point at this server;
#          ports 80 and 443 must be open). Caddy gets the HTTPS certificate itself.
#   arg 2  the image version to run (a tag from the Release workflow, e.g. 0.1.0)
#
# What it does: creates /opt/sethucms, writes a .env with fresh random secrets
# (only if there is none; it never overwrites one), starts Postgres + gateway + Caddy,
# waits for /v1/health, and installs a nightly database backup.
# It never prints a secret. Read the admin token with:  sudo grep ADMIN_TOKEN /opt/sethucms/.env
set -euo pipefail

DOMAIN="${1:-}"; VERSION="${2:-}"
[ -n "$DOMAIN" ] && [ -n "$VERSION" ] || { echo "usage: bash deploy/install-server.sh <domain> <image-version>" >&2; exit 2; }
case "$DOMAIN" in *[!A-Za-z0-9.-]*|"") echo "that does not look like a domain: $DOMAIN" >&2; exit 2 ;; esac
case "$VERSION" in *[!A-Za-z0-9._-]*|"") echo "bad version: $VERSION" >&2; exit 2 ;; esac

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${SETHU_DIR:-/opt/sethucms}"
IMAGE="ghcr.io/sethucms/sethucms:$VERSION"

command -v docker >/dev/null || { echo "Docker is not installed" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "the docker compose plugin is not installed" >&2; exit 1; }
[ -f "$SRC/compose.production.yml" ] && [ -f "$SRC/Caddyfile" ] || { echo "run this from a clone of the sethucms repository" >&2; exit 1; }

SUDO=""; [ -w "$(dirname "$DEST")" ] || SUDO="sudo"
$SUDO mkdir -p "$DEST/backups"
$SUDO cp "$SRC/compose.production.yml" "$SRC/Caddyfile" "$DEST/"
$SUDO chown -R "$(id -u):$(id -g)" "$DEST"
cd "$DEST"

if [ -f .env ]; then
  echo "keeping the existing $DEST/.env"
  # Only the image tag and domain change on an upgrade.
  sed -i "s#^SETHUCMS_IMAGE=.*#SETHUCMS_IMAGE=$IMAGE#; s#^SETHUCMS_DOMAIN=.*#SETHUCMS_DOMAIN=$DOMAIN#" .env
else
  umask 077
  {
    echo "SETHUCMS_IMAGE=$IMAGE"
    echo "SETHUCMS_DOMAIN=$DOMAIN"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "SETHUCMS_VAULT_KEY=$(openssl rand -base64 32)"
    echo "SETHUCMS_CURSOR_SECRET=$(openssl rand -base64 32)"
    echo "SETHUCMS_PREVIEW_SECRET=$(openssl rand -base64 32)"
    echo "SETHUCMS_ADMIN_TOKEN=$(openssl rand -hex 32)"
    echo "SETHUCMS_WORKER=on"
    echo "# Caddy is in front of the gateway, so trust its forwarded address."
    echo "SETHUCMS_TRUST_PROXY=true"
  } > .env
  chmod 600 .env
  echo "created $DEST/.env with new secrets"
  echo "IMPORTANT: copy SETHUCMS_VAULT_KEY somewhere safe and separate (a password manager)."
  echo "           Without it, saved database passwords cannot be decrypted, even from a backup."
fi
chmod 600 .env

echo "pulling the image $IMAGE"
docker compose --env-file .env -f compose.production.yml pull
docker compose --env-file .env -f compose.production.yml config -q
docker compose --env-file .env -f compose.production.yml up -d postgres gateway caddy

echo "waiting for the gateway"
ok=""
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8080/v1/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 3
done
if [ -z "$ok" ]; then
  docker compose --env-file .env -f compose.production.yml logs --no-color --tail=80 gateway
  echo "the gateway did not become healthy" >&2
  exit 1
fi
echo "gateway is healthy"

# Nightly backup of the shared state (connections, drafts, tokens, audit log live in Postgres).
cat > backup.sh <<'BK'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
umask 077
f="backups/sethucms-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose --env-file .env -f compose.production.yml exec -T postgres pg_dump -U sethucms sethucms | gzip > "$f"
# keep the newest 14
ls -1t backups/sethucms-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm --
echo "backup written: $f"
BK
chmod 700 backup.sh
if ! crontab -l 2>/dev/null | grep -q "$DEST/backup.sh"; then
  ( crontab -l 2>/dev/null; echo "17 3 * * * $DEST/backup.sh >> $DEST/backups/backup.log 2>&1" ) | crontab -
  echo "nightly backup scheduled at 03:17"
fi

echo
echo "Done. Next:"
echo "  1. Check https://$DOMAIN/v1/health from your own computer (the certificate can take a minute)."
echo "  2. Open https://$DOMAIN and sign in with:  sudo grep ADMIN_TOKEN $DEST/.env"
echo "  3. Add your database under Connections, read-only first, and expose one collection."
echo "  4. Test a restore from $DEST/backups before you rely on it."
echo "  5. Firewall: allow only 22, 80 and 443 (for example: sudo ufw allow 22,80,443/tcp && sudo ufw enable)."
