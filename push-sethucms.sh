#!/usr/bin/env bash
# One-click GitHub push for SethuCMS 0.1.0.
#
# What it does, in order:
#   1. Checks GitHub login for every repo (right away, so problems show today).
#   2. Waits until the push time (default: 10 Oct 2026, 9:00 pm India time).
#   3. Commits any pending changes, scans for secrets, pushes, tags v0.1.0,
#      and (only if the secret scan was clean) makes the repos public.
#
# It never force-pushes. If anything looks wrong it stops before pushing.
#
# Options:  --now        skip the wait and push immediately
#           --no-public  push, but leave the repos private
#           --dry-run    show what would happen, change nothing
set -u

ROOT="${SETHU_ROOT:-$HOME}"
ORG="SethuCMS"
PUSH_AT="${PUSH_AT:-2026-10-10 21:00}"
PUSH_TZ="Asia/Kolkata"
MSG="chore: release 0.1.0"
TAG="v0.1.0"
TAG_REPOS="sethucms sethucms-adapter-sdk sethucms-adapters sethucms-sdk-ts"
REPOS="sethucms sethucms-adapter-sdk sethucms-adapters sethucms-admin sethucms-docs sethucms-sdk-ts sethucms-examples"

NOW=0; PUBLIC=1; DRY=0
for a in "$@"; do
  case "$a" in
    --now) NOW=1 ;;
    --no-public) PUBLIC=0 ;;
    --dry-run) DRY=1 ;;
  esac
done

# Keep the computer awake while we wait (a sleeping laptop would miss 9 pm).
if [ -z "${SETHU_AWAKE:-}" ] && command -v systemd-inhibit >/dev/null 2>&1 \
   && systemd-inhibit --what=sleep:idle true >/dev/null 2>&1; then
  SETHU_AWAKE=1 exec systemd-inhibit --what=sleep:idle --who=SethuCMS \
    --why="Waiting to push SethuCMS to GitHub" bash "$0" "$@"
fi

LOG="$ROOT/sethucms-push-$(date +%Y%m%d-%H%M).log"
exec > >(tee -a "$LOG") 2>&1

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   OK    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*"; }
bad()  { printf '   FAIL  %s\n' "$*"; }
finish() {
  printf '\nLog saved to: %s\n' "$LOG"
  printf 'Press Enter to close this window. '
  read -r _ || true
  exit "${1:-0}"
}

export GIT_TERMINAL_PROMPT=0   # fail instead of hanging on a password prompt

command -v git >/dev/null 2>&1 || { bad "git is not installed"; finish 1; }
HAVE_GH=0; command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 && HAVE_GH=1
HAVE_LEAKS=0; command -v gitleaks >/dev/null 2>&1 && HAVE_LEAKS=1

# Work out the final repo list: folders that exist and are git repos.
LIST=""
for r in $REPOS; do
  if [ -d "$ROOT/$r/.git" ]; then LIST="$LIST $r"; else warn "$r: no git repo at $ROOT/$r, skipping"; fi
done
[ -n "$LIST" ] || { bad "no repos found under $ROOT"; finish 1; }

slug_of() {   # real "owner/name" on GitHub for a local repo (follows renames)
  [ "$HAVE_GH" = 1 ] || return 1
  ( cd "$ROOT/$1" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null )
}

fix_remote() {   # point a stale or renamed remote at the repo's current GitHub address
  local r="$1" url slug new
  url=$(git -C "$ROOT/$r" remote get-url origin 2>/dev/null) || return 0
  slug=$(slug_of "$r") || return 0
  [ -n "$slug" ] || return 0
  new="https://github.com/$slug.git"
  if [ "$url" != "$new" ]; then
    warn "$r: remote $url -> $new"
    [ "$DRY" = 1 ] || git -C "$ROOT/$r" remote set-url origin "$new"
  fi
}

############################ Step 1: login check ############################
say "Step 1 of 4: checking GitHub access"
if [ "$HAVE_GH" = 1 ]; then ok "gh is logged in"; else warn "gh is not logged in (git login is tested per repo below)"; fi
PRE_FAIL=0
for r in $LIST; do
  d="$ROOT/$r"
  if ! git -C "$d" remote get-url origin >/dev/null 2>&1; then
    bad "$r: no GitHub address set. Run: git -C $d remote add origin https://github.com/$ORG/<repo-name>.git"
    PRE_FAIL=1; continue
  fi
  fix_remote "$r"
  if git -C "$d" ls-remote origin >/dev/null 2>&1; then
    ok "$r: GitHub reachable and login works"
  else
    bad "$r: cannot read origin. Run 'gh auth login' (choose HTTPS) and make sure the repo exists on GitHub."
    PRE_FAIL=1
  fi
done
if [ "$PRE_FAIL" = 1 ]; then
  say "Stopped. Fix the lines marked FAIL, then click this again."
  finish 1
fi
[ "$HAVE_LEAKS" = 1 ] && ok "gitleaks found (secret scan will run)" || \
  warn "gitleaks not installed: repos will be pushed but NOT made public. Install it to enable that."

############################ Step 2: wait ####################################
if [ "$NOW" = 0 ]; then
  TARGET=$(date -d "TZ=\"$PUSH_TZ\" $PUSH_AT" +%s 2>/dev/null) || { bad "bad PUSH_AT"; finish 1; }
  say "Step 2 of 4: waiting until $PUSH_AT India time"
  echo "   Leave this window open and the computer on. Press Ctrl+C to cancel."
  while :; do
    left=$(( TARGET - $(date +%s) ))
    [ "$left" -le 0 ] && break
    printf '\r   Time left: %02dh %02dm %02ds   ' $((left/3600)) $((left%3600/60)) $((left%60))
    sleep $(( left > 30 ? 30 : 1 ))
  done
  printf '\n'
else
  say "Step 2 of 4: no wait (--now)"
fi

############################ Step 3: prepare + scan ##########################
say "Step 3 of 4: preparing repos and scanning for secrets"
SCAN_FAIL=0
for r in $LIST; do
  d="$ROOT/$r"
  # keep these helper files out of the public repo
  if [ "$r" = sethucms ]; then
    for f in push-sethucms.sh push-sethucms.desktop 1-push-today-private.desktop 2-make-public-9pm.desktop FOR-DAD.txt fix-github-config.sh umbrella-ci/; do
      grep -qxF "$f" "$d/.git/info/exclude" 2>/dev/null || echo "$f" >> "$d/.git/info/exclude"
    done
    if [ -e "$d/scripts/rename-to-sethucms.sh" ] && git -C "$d" ls-files --error-unmatch scripts/rename-to-sethucms.sh >/dev/null 2>&1; then
      warn "$r: removing scripts/rename-to-sethucms.sh (old rename helper)"
      [ "$DRY" = 1 ] || git -C "$d" rm -q scripts/rename-to-sethucms.sh
    fi
  fi
  # a repo with no commits yet (like the examples repo): line up with GitHub first
  if ! git -C "$d" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$d" fetch -q origin 2>/dev/null
    if git -C "$d" rev-parse --verify origin/main >/dev/null 2>&1; then
      warn "$r: no local commits, aligning with origin/main (files are kept)"
      [ "$DRY" = 1 ] || git -C "$d" reset -q origin/main
    fi
  fi
  if [ -n "$(git -C "$d" status --porcelain)" ]; then
    warn "$r: has uncommitted changes, committing them as '$MSG'"
    if [ "$DRY" = 0 ]; then
      git -C "$d" add -A && git -C "$d" commit -q -m "$MSG" || { bad "$r: commit failed (set git user.name / user.email?)"; SCAN_FAIL=1; continue; }
    fi
  else
    ok "$r: nothing new to commit"
  fi
  if [ "$HAVE_LEAKS" = 1 ]; then
    if gitleaks detect --source "$d" --redact --no-banner >/dev/null 2>&1; then
      ok "$r: secret scan clean"
    else
      bad "$r: gitleaks found possible secrets. Run: gitleaks detect --source $d --redact -v"
      SCAN_FAIL=1
    fi
  fi
done
if [ "$SCAN_FAIL" = 1 ]; then
  say "Stopped BEFORE pushing anything. Fix the FAIL lines above and click again."
  finish 1
fi

############################ Step 4: push ####################################
say "Step 4 of 4: pushing to GitHub"
PUSH_FAIL=0
for r in $LIST; do
  d="$ROOT/$r"
  br=$(git -C "$d" symbolic-ref --short HEAD 2>/dev/null || echo main)
  if [ "$DRY" = 1 ]; then ok "$r: would push $br"; continue; fi
  out=$(git -C "$d" push -u origin "$br" 2>&1); rc=$?
  printf '%s\n' "$out" | sed 's/^/      /'
  if [ "$rc" = 0 ]; then
    ok "$r: pushed $br"
  else
    bad "$r: push was rejected (not forced). Someone may have changed GitHub; ask Kasinadh."
    PUSH_FAIL=1; continue
  fi
  case " $TAG_REPOS " in *" $r "*)
    git -C "$d" rev-parse -q --verify "refs/tags/$TAG" >/dev/null || git -C "$d" tag -a "$TAG" -m "SethuCMS $TAG"
    git -C "$d" push -q origin "$TAG" 2>&1 | sed 's/^/      /'
    ok "$r: tag $TAG pushed" ;;
  esac
  if [ "$PUBLIC" = 1 ] && [ "$HAVE_GH" = 1 ] && [ "$HAVE_LEAKS" = 1 ]; then
    slug=$(slug_of "$r"); slug="${slug:-$ORG/$r}"
    vis=$(gh repo view "$slug" --json visibility -q .visibility 2>/dev/null)
    if [ "$vis" = "PRIVATE" ]; then
      if gh repo edit "$slug" --visibility public --accept-visibility-change-consequences >/dev/null 2>&1; then
        ok "$r: now PUBLIC"
      else
        warn "$r: could not make public (needs admin rights); do it in GitHub settings"
      fi
    else
      ok "$r: already ${vis:-unknown}"
    fi
  fi
done

if [ "$PUSH_FAIL" = 1 ]; then
  say "Finished with problems. See FAIL lines above."; finish 1
fi
say "All done. SethuCMS is on GitHub."
echo "   Still to do by hand: npm publish (needs your npm one-time code)."
finish 0
