#!/usr/bin/env bash
# Protect the default branch (main) of every SethuCMS repository.
#   bash protect-main.sh              block force-push and deletion of main
#   bash protect-main.sh --require-pr also require a pull request (you, as admin, can still push directly)
#   bash protect-main.sh --dry-run    show what would happen
# Needs: gh logged in (gh auth login) as an owner of the SethuCMS organisation.
# Private repositories need a paid plan for branch rules; if GitHub says so, run this again once the repos are public.
set -u
ORG=SethuCMS
REQUIRE_PR=0; DRY=0
for a in "$@"; do case "$a" in --require-pr) REQUIRE_PR=1;; --dry-run) DRY=1;; esac; done
command -v gh >/dev/null || { echo "Install the GitHub CLI first (gh)."; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login"; exit 1; }
# Every non-archived repository in the organisation, so nothing is forgotten.
mapfile -t REPOS < <(gh repo list "$ORG" --limit 200 --json name,isArchived -q '.[] | select(.isArchived|not) | .name')
[ "${#REPOS[@]}" -gt 0 ] || { echo "No repositories found in $ORG (are you logged in as an owner?)."; exit 1; }

PR_RULE=""
[ "$REQUIRE_PR" = 1 ] && PR_RULE=',{"type":"pull_request","parameters":{"required_approving_review_count":0,"dismiss_stale_reviews_on_push":false,"require_code_owner_review":false,"require_last_push_approval":false,"required_review_thread_resolution":false}}'
BODY=$(cat <<JSON
{"name":"protect-main","target":"branch","enforcement":"active",
 "conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}},
 "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}],
 "rules":[{"type":"deletion"},{"type":"non_fast_forward"}$PR_RULE]}
JSON
)
ok=0; bad=0
for r in "${REPOS[@]}"; do
  # Use the repository's current full name, so renamed repositories do not answer "Moved Permanently".
  slug=$(gh api "repos/$ORG/$r" -q .full_name 2>/dev/null) || { echo "SKIP  $ORG/$r (not found or no access)"; continue; }
  if gh api "repos/$slug/rulesets" -q '.[].name' 2>/dev/null | grep -qx protect-main; then echo "OK    $slug (already protected)"; ok=$((ok+1)); continue; fi
  if [ "$DRY" = 1 ]; then echo "WOULD protect $slug"; continue; fi
  if out=$(printf '%s' "$BODY" | gh api -X POST "repos/$slug/rulesets" --input - 2>&1); then
    echo "DONE  $slug"; ok=$((ok+1))
  else
    bad=$((bad+1)); echo "FAIL  $slug: $(printf '%s' "$out" | head -c 200)"
    printf '%s' "$out" | grep -qi "upgrade\|plan" && echo "      (private repo on a free plan: run again after it is public)"
  fi
done
echo "protected: $ok   failed: $bad"
