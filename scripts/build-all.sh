#!/bin/sh
# Build everything needed to run the CMS on one machine, in dependency order.
#
# The repositories are expected side by side in the same folder:
#   sethucms  sethucms-adapter-sdk  sethucms-adapters  sethucms-admin
# (until the packages are published, they link to each other by folder).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PARENT=$(dirname "$ROOT")

for repo in sethucms-adapter-sdk sethucms-adapters sethucms-admin; do
  if [ ! -d "$PARENT/$repo" ]; then
    echo "Missing $PARENT/$repo. Clone it next to sethucms and run this again." >&2
    exit 1
  fi
done

step() { printf '\n==> %s\n' "$1"; }

step "1/5  core"
(cd "$ROOT" && pnpm install && pnpm --filter @sethucms/core build)

step "2/5  adapter SDK"
(cd "$PARENT/sethucms-adapter-sdk" && pnpm install && pnpm build)

step "3/5  adapters"
(cd "$PARENT/sethucms-adapters" && pnpm install && pnpm -r build)

step "4/5  gateway"
(cd "$ROOT" && pnpm install && pnpm --filter @sethucms/api build)

step "5/5  admin app"
(cd "$PARENT/sethucms-admin" && pnpm install && pnpm build:embedded)

printf '\nDone. Start it with:  sh scripts/run-local.sh\n'
