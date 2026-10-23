#!/usr/bin/env bash
# Publish all SethuCMS 0.1.0 packages to npm, in dependency order.
# Usage: bash ~/sethucms/deploy/publish-all.sh [--dry-run]
# Reads the token from ~/.config/sethucms/npm-token (never printed).
set -euo pipefail

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY="--dry-run"

TOKEN_FILE="$HOME/.config/sethucms/npm-token"
[ -s "$TOKEN_FILE" ] || { echo "No token at $TOKEN_FILE"; exit 1; }
RC="$(mktemp)"; chmod 600 "$RC"
trap 'rm -f "$RC"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$(cat "$TOKEN_FILE")" > "$RC"
export NPM_CONFIG_USERCONFIG="$RC"
echo "npm user: $(npm whoami)"

PKGS=(
  "$HOME/sethucms/packages/core"
  "$HOME/sethucms-adapter-sdk"
  "$HOME/sethucms-adapters/packages/sql-kit"
  "$HOME/sethucms-adapters/packages/postgres"
  "$HOME/sethucms-adapters/packages/mysql"
  "$HOME/sethucms-adapters/packages/sqlite"
  "$HOME/sethucms-adapters/packages/mongodb"
  "$HOME/sethucms-adapters/packages/firestore"
  "$HOME/sethucms-adapters/packages/memory"
  "$HOME/sethucms-sdk-ts"
)

for d in "$HOME/sethucms" "$HOME/sethucms-adapter-sdk" "$HOME/sethucms-adapters" "$HOME/sethucms-sdk-ts"; do
  (cd "$d" && pnpm install --silent && { [ "$d" = "$HOME/sethucms" ] && pnpm --filter @sethucms/core build || pnpm -r build; } >/dev/null)
done

OTP=""
for d in "${PKGS[@]}"; do
  name="$(node -p "require('$d/package.json').name")"
  ver="$(node -p "require('$d/package.json').version")"
  if npm view "$name@$ver" version >/dev/null 2>&1; then
    echo "skip   $name@$ver (already on npm)"; continue
  fi
  if [ -n "$DRY" ]; then
    echo "dryrun $name@$ver"; (cd "$d" && pnpm publish --dry-run --no-git-checks >/dev/null)
    continue
  fi
  read -rp "6-digit code for $name@$ver: " OTP
  echo "publish $name@$ver"
  (cd "$d" && pnpm publish --no-git-checks --otp="$OTP")
done
echo "Done."
