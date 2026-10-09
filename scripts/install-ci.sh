#!/bin/sh
# Copies the CI/CD workflows into each repository's .github folder.
# (They are kept in ci-workflows/ because tools that edit files for you are not allowed to write into .github.)
#
#   cd ~/sethucms && sh scripts/install-ci.sh
#
# Safe to run again. Nothing is committed or pushed; review with `git status` in each repository.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PARENT=$(dirname "$ROOT")
SRC="$ROOT/ci-workflows"

for repo in "$SRC"/*/; do
  name=$(basename "$repo")
  dest="$PARENT/$name"
  if [ ! -d "$dest" ]; then
    echo "skip   $name (folder not found next to sethucms)"
    continue
  fi
  mkdir -p "$dest/.github"
  cp -R "$repo". "$dest/.github/"
  echo "copied $name"
done

# An earlier CI file was created in the wrong folder; the new one is .github/workflows/ci.yml.
if [ -f "$ROOT/.github/ci/ci.yml" ]; then
  rm "$ROOT/.github/ci/ci.yml"
  rmdir "$ROOT/.github/ci" 2>/dev/null || true
  echo "removed old .github/ci/ci.yml"
fi
# The infra repo's old copy is replaced by .github/workflows/infra-ci.yml.
if [ -f "$PARENT/sethucms-infra/ci/infra-ci.yml" ]; then
  rm "$PARENT/sethucms-infra/ci/infra-ci.yml"
  rmdir "$PARENT/sethucms-infra/ci" 2>/dev/null || true
  echo "removed old sethucms-infra/ci/infra-ci.yml"
fi
echo "Done. Review with: git status (in each repository)"
