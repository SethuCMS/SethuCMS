#!/bin/sh
# Removes files that duplicate something else or are no longer used. Lists them first and asks.
#
#   cd ~/sethucms && sh scripts/clean-leftovers.sh
#
# Nothing is committed. Review with `git status` afterwards.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PARENT=$(dirname "$ROOT")

LIST=""
add() { [ -e "$1" ] && LIST="$LIST
$1"; return 0; }

# 1. A second copy of the TypeScript SDK. The real one is the sethucms-sdk-ts repository.
add "$ROOT/packages/sdk-ts"
# 2. An old admin HTTP helper that nothing imports any more.
if [ -f "$PARENT/sethucms-admin/src/api/http.ts" ] && ! grep -rqE "from ['\"]\./http['\"]|api/http" "$PARENT/sethucms-admin/src" --include=*.ts --include=*.tsx --exclude=http.ts; then
  add "$PARENT/sethucms-admin/src/api/http.ts"
fi
# 3. The staging copy of the workflows, once they are installed into .github/workflows.
if [ -f "$ROOT/.github/workflows/ci.yml" ]; then add "$ROOT/ci-workflows"; fi

if [ -z "$LIST" ]; then echo "Nothing to remove."; exit 0; fi

echo "These will be deleted:"
echo "$LIST"
printf "Delete them? [y/N] "
read -r answer
[ "$answer" = "y" ] || { echo "Left everything as it was."; exit 0; }

echo "$LIST" | while IFS= read -r path; do
  [ -n "$path" ] && rm -rf "$path" && echo "removed $path"
done
echo "Run 'pnpm install' in sethucms to refresh the workspace, then 'git status' in each repository."
