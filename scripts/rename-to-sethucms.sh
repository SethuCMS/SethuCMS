#!/bin/sh
# Rename the project from AnyDB CMS to SethuCMS in every repository folder.
#
#   sh anydbcms/scripts/rename-to-sethucms.sh ~            # look only: lists what would change
#   sh anydbcms/scripts/rename-to-sethucms.sh ~ --apply    # do it
#
# The argument is the folder that holds the repositories (anydbcms, anydbcms-docs, ...).
# What it does, in this order:
#   1. rewrites text inside files (names, package scope, environment variables, docs)
#   2. renames files and folders whose names contain "anydbcms"
#   3. renames the repository folders themselves (anydbcms -> sethucms, anydbcms-admin -> sethucms-admin, ...)
# It never runs git, never commits, and skips node_modules, dist, .git and your data folders.
# Afterwards: in each repository run  pnpm install  (the lock files are updated, not frozen),
# then rebuild. See docs/ and QUICKSTART.md. Back up or commit-stash your work first if you can.
set -eu

PARENT=${1:?Give the folder that holds the repositories, for example: sh rename-to-sethucms.sh ~}
MODE=${2:-}
REPOS="anydbcms anydbcms-adapter-sdk anydbcms-adapters anydbcms-admin anydbcms-docs anydbcms-sdk-ts anydbcms-sdk-python anydbcms-sdk-dart anydbcms-adapter-template-python anydbcms-adapter-template-go anydbcms-infra"
SELF=rename-to-sethucms.sh

# Longest names first so that nothing is half-replaced.
rewrite() {
  sed -e 's/AnyDB CMS/SethuCMS/g' \
      -e 's/AnyDBCMS/SethuCMS/g' \
      -e 's/ANYDBCMS/SETHUCMS/g' \
      -e 's/anydbcms/sethucms/g' \
      -e 's/AnyDbApiError/SethuApiError/g' \
      -e 's/AnyDbError/SethuError/g' \
      -e 's/AnyDbClient/SethuClient/g' \
      -e 's/AnyDb/Sethu/g' \
      -e 's/AnyDB/Sethu/g' \
      -e 's/ANYDB/SETHU/g' \
      -e 's/anydb/sethu/g'
}

LIST=$(mktemp)
for r in $REPOS; do
  [ -d "$PARENT/$r" ] || continue
  find "$PARENT/$r" \( -name node_modules -o -name dist -o -name .git -o -name '.anydbcms-data' -o -name '.sethucms-data' \) -prune -o \
       -type f ! -name "$SELF" -print
done | while IFS= read -r f; do
  # Only text files that mention the old name.
  if grep -Iqi 'anydb' "$f" 2>/dev/null; then echo "$f"; fi
done > "$LIST"

COUNT=$(wc -l < "$LIST" | tr -d ' ')
echo "Files with text to change: $COUNT"

if [ "$MODE" != "--apply" ]; then
  sed 's|^|  |' "$LIST" | head -40
  [ "$COUNT" -gt 40 ] && echo "  ... and $((COUNT - 40)) more"
  echo
  echo "Folders that would be renamed:"
  for r in $REPOS; do [ -d "$PARENT/$r" ] && echo "  $r -> $(echo "$r" | rewrite)"; done
  echo
  echo "Nothing was changed. Run again with --apply to do it."
  rm -f "$LIST"; exit 0
fi

# 1. text inside files
while IFS= read -r f; do
  rewrite < "$f" > "$f.rename-tmp" && cat "$f.rename-tmp" > "$f" && rm -f "$f.rename-tmp"
done < "$LIST"
rm -f "$LIST"

# 2. file and folder names inside the repositories (deepest first)
for r in $REPOS; do
  [ -d "$PARENT/$r" ] || continue
  find "$PARENT/$r" \( -name node_modules -o -name dist -o -name .git \) -prune -o -depth -iname '*anydb*' -print | while IFS= read -r p; do
    d=$(dirname "$p"); b=$(basename "$p"); n=$(echo "$b" | rewrite)
    [ "$b" = "$n" ] || mv "$p" "$d/$n"
  done
done

# 3. the repository folders
for r in $REPOS; do
  n=$(echo "$r" | rewrite)
  if [ -d "$PARENT/$r" ]; then
    if [ -e "$PARENT/$n" ]; then echo "SKIPPED: $PARENT/$n already exists, left $r in place" >&2; else mv "$PARENT/$r" "$PARENT/$n"; fi
  fi
done

echo
echo "Done. Next, in each repository folder (core first, then adapter-sdk, adapters, admin):"
echo "  pnpm install     # refreshes the lock files and the folder links"
echo "  then:  sh sethucms/scripts/build-all.sh"
echo "Also: rename your GitHub organisation and repositories, then update each git remote."
echo "Built files (dist/) and PDFs still carry the old name; rebuild them."
