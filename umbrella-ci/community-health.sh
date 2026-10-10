#!/usr/bin/env bash
# Adds the community and security files every SethuCMS repository should have,
# and switches on GitHub's security features for each repo.
#
#   bash community-health.sh            write missing files + apply settings
#   bash community-health.sh --pr       also open one pull request per repo
#   bash community-health.sh --files    files only, no GitHub settings
#   bash community-health.sh --settings settings only, no files
#   bash community-health.sh --dry-run  show what would happen
#
# Rules it follows:
#  - never overwrites a file that already exists
#  - no email addresses, phone numbers or names anywhere: reports go through
#    GitHub's private reporting, so nothing personal is published
#  - blank issues are off, so every issue arrives in a form (less spam)
#  - needs: git, and gh logged in as an org owner for the settings step
set -uo pipefail

ORG="${SETHU_ORG:-SethuCMS}"
PR=0; FILES=1; SETTINGS=1; DRY=0
for a in "$@"; do
  case "$a" in
    --pr) PR=1 ;;
    --files) SETTINGS=0 ;;
    --settings) FILES=0 ;;
    --dry-run) DRY=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
put() { # put <path> : writes stdin unless the file exists
  local path="$1"
  if [ -e "$path" ]; then cat >/dev/null; say "    keep   $path"; return; fi
  if [ "$DRY" = 1 ]; then cat >/dev/null; say "    would add $path"; return; fi
  mkdir -p "$(dirname "$path")"
  sed "s#__SLUG__#$SLUG#g; s#__NAME__#$NAME#g" >"$path"
  say "    add    $path"
}

write_files() {
  put SECURITY.md <<'EOF'
# Security policy

__NAME__ is built security-first. We want to hear about anything that weakens it.

## Reporting a vulnerability

Please do **not** open a public issue, pull request or discussion for a
vulnerability.

1. Open <https://github.com/__SLUG__/security/advisories/new>
   (the repository's **Security** tab, then **Report a vulnerability**).
2. Say what you found, how to reproduce it, and which version is affected.

Reports stay private between you and the maintainers. You will get a first
reply within 3 working days. We fix confirmed problems before announcing them,
publish an advisory with the fix, and credit you if you want to be credited.

Please do not include real secrets, personal data or production credentials in a
report. A proof of concept against your own test setup is enough.

## Supported versions

Only the latest release of the 0.x line receives security fixes while the
project is young.

## Scope

In scope: the code in this repository and how it handles permissions, tokens,
sign-in, input and webhooks. Out of scope: problems that need control of the
server or database first, social engineering, denial of service by sheer volume,
and unmodified third-party services.

## Good-faith research

If you test only against your own installation, do not read or change other
people's data, and give us reasonable time to fix, we will not pursue action
against you.
EOF

  put CODE_OF_CONDUCT.md <<'EOF'
# Code of conduct

We want __NAME__ to be a place where people can ask questions, report problems
and send code without being treated badly.

## What we expect

- Be respectful and assume good faith. Disagree with the idea, not the person.
- Keep to the topic of the project. No advertising, promotion or link dropping.
- Do not harass, insult, threaten or discriminate against anyone.
- Do not share other people's private information.

## What we will do

Maintainers may edit, hide or remove comments, issues and pull requests, and
may block people who break these rules. Spam and unsolicited promotion are
removed without warning.

## Reporting

To report behaviour privately, open
<https://github.com/__SLUG__/security/advisories/new> and start the title with
"Conduct report". Only the maintainers can see it.

This code of conduct applies in this repository's issues, pull requests,
discussions and any other space that represents the project.
EOF

  put SUPPORT.md <<'EOF'
# Getting help

- **Bug or something broken:** open an issue with the bug form.
- **Missing feature:** open an issue with the feature form.
- **Question about using __NAME__:** check the README first, then open an issue
  with the question form.
- **Security problem:** do not post it publicly. Use
  <https://github.com/__SLUG__/security/advisories/new>.

We cannot give help by private message. Keeping it in the issue lets the next
person find the answer.
EOF

  put CONTRIBUTING.md <<'EOF'
# Contributing to __NAME__

Thanks for helping. The project is MIT licensed and contributions are welcome.
The main guide, with the full multi-repo set-up, lives in
[SethuCMS/sethucms](https://github.com/SethuCMS/sethucms/blob/main/CONTRIBUTING.md).

## Set up and test

__SETUP__

## Before you open a pull request

- Keep it small and focused, with a test for new behaviour.
- Open an issue first for anything large, so we agree on the direction.
- Run the formatter and the tests above, and make sure they pass.
- Use braces on every `if`, keep functions short, and add a comment for anything
  security-relevant that is not obvious.
- Do not commit secrets, `.env` files, personal data or generated build output.
- Security fixes: report privately first, see [SECURITY.md](SECURITY.md).

## Pull requests from first-time contributors

CI on a first pull request needs a maintainer's approval before it runs. That is
a spam and abuse guard, not a judgement of your change.

By contributing you agree that your work is released under this repository's
licence.
EOF

  put .github/ISSUE_TEMPLATE/config.yml <<'EOF'
blank_issues_enabled: false
contact_links:
  - name: Report a security vulnerability (private)
    url: https://github.com/__SLUG__/security/advisories/new
    about: Do not open a public issue for security problems.
EOF

  put .github/ISSUE_TEMPLATE/bug.yml <<'EOF'
name: Bug report
description: Something does not work as documented
labels: [bug]
body:
  - type: markdown
    attributes:
      value: |
        Security problem? Stop here and use the private report link on the
        previous page. Never paste secrets, tokens or personal data.
  - type: textarea
    id: what
    attributes:
      label: What happened
      description: What you did, what you expected, what you got.
    validations: { required: true }
  - type: textarea
    id: repro
    attributes:
      label: Steps to reproduce
      description: The smallest set of steps or code that shows it.
    validations: { required: true }
  - type: input
    id: version
    attributes:
      label: Version
      description: Package version or commit.
    validations: { required: true }
  - type: input
    id: env
    attributes:
      label: Environment
      description: OS, runtime version, and database (name and version).
  - type: textarea
    id: logs
    attributes:
      label: Logs
      description: Relevant output, with anything secret removed.
      render: shell
EOF

  put .github/ISSUE_TEMPLATE/feature.yml <<'EOF'
name: Feature request
description: Suggest an improvement
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: The problem
      description: What are you trying to do that is hard or impossible today?
    validations: { required: true }
  - type: textarea
    id: idea
    attributes:
      label: What you would like
    validations: { required: true }
  - type: textarea
    id: alternatives
    attributes:
      label: Alternatives you tried
EOF

  put .github/ISSUE_TEMPLATE/question.yml <<'EOF'
name: Question
description: Ask how to use this project
labels: [question]
body:
  - type: textarea
    id: question
    attributes:
      label: Your question
      description: Say what you are trying to do and what you have tried. Do not paste secrets.
    validations: { required: true }
  - type: input
    id: version
    attributes:
      label: Version
EOF

  put .github/PULL_REQUEST_TEMPLATE.md <<'EOF'
## What and why

<!-- What does this change, and why? Link the issue if there is one. -->

## How it was tested

<!-- Commands you ran, new tests added. -->

## Checklist

- [ ] Tests added or updated, and they pass
- [ ] Formatter run
- [ ] No secrets, `.env` files or personal data in the diff
- [ ] Docs updated if behaviour changed
- [ ] This is not a security fix (those go through a private report, see SECURITY.md)
EOF
}

setup_text() {
  if [ -f package.json ]; then
    printf '%s\n' '```' 'pnpm install' 'pnpm build' 'pnpm test' '```'
  elif [ -f pubspec.yaml ]; then
    printf '%s\n' '```' 'dart pub get' 'dart format .' 'dart analyze --fatal-infos' 'dart test' '```'
  elif [ -f pyproject.toml ]; then
    printf '%s\n' '```' 'python -m venv .venv && . .venv/bin/activate' 'pip install -e ".[dev]"' 'pytest' '```'
  elif [ -f go.mod ]; then
    printf '%s\n' '```' 'gofmt -l .' 'go vet ./...' 'go test ./...' '```'
  else
    echo 'See the README for build and test commands.'
  fi
}

apply_settings() {
  local s="$1"
  local api=(gh api -H "Accept: application/vnd.github+json")
  local priv; priv=$(gh repo view "$s" --json isPrivate -q .isPrivate 2>/dev/null || echo unknown)
  say "  settings ($s, private=$priv)"
  if [ "$DRY" = 1 ]; then say "    would apply security settings"; return; fi
  try() { local label="$1"; shift; if "$@" >/dev/null 2>&1; then say "    ok     $label"; else say "    skip   $label (plan or permission does not allow it)"; fi; }
  try "no wiki/projects, delete merged branches" "${api[@]}" -X PATCH "repos/$s" -F has_wiki=false -F has_projects=false -F delete_branch_on_merge=true
  try "private vulnerability reporting" "${api[@]}" -X PUT "repos/$s/private-vulnerability-reporting"
  try "dependabot alerts" "${api[@]}" -X PUT "repos/$s/vulnerability-alerts"
  try "dependabot security updates" "${api[@]}" -X PUT "repos/$s/automated-security-fixes"
  try "secret scanning + push protection" "${api[@]}" -X PATCH "repos/$s" \
    -f 'security_and_analysis[secret_scanning][status]=enabled' \
    -f 'security_and_analysis[secret_scanning_push_protection][status]=enabled'
  try "workflows read-only by default" "${api[@]}" -X PUT "repos/$s/actions/permissions/workflow" \
    -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false
  try "approve CI for all outside contributors" "${api[@]}" -X PUT "repos/$s/actions/permissions/fork-pr-contributor-approval" \
    -f approval_policy=all_external_contributors
}

say "== SethuCMS community and security files =="
found=0
for dir in "$HOME"/sethucms*/; do
  [ -d "$dir/.git" ] || continue
  found=1
  cd "$dir" || continue
  NAME="$(basename "$dir")"
  url="$(git remote get-url origin 2>/dev/null || true)"
  SLUG="$(printf '%s' "$url" | sed -E 's#^(git@github.com:|https://github.com/)##; s#\.git$##')"
  if command -v gh >/dev/null 2>&1 && [ -n "$SLUG" ]; then
    real="$(gh repo view "$SLUG" --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    [ -n "$real" ] && SLUG="$real"
  fi
  [ -n "$SLUG" ] || SLUG="$ORG/$NAME"
  NAME="${SLUG#*/}"
  say ""; say "-- $SLUG ($dir)"

  if [ "$FILES" = 1 ]; then
    SETUP="$(setup_text)"
    # SETUP is multi-line, so substitute it after the generic pass.
    write_files
    if [ "$DRY" != 1 ] && [ -f CONTRIBUTING.md ] && grep -q '__SETUP__' CONTRIBUTING.md; then
      python3 - "$SETUP" <<'PY'
import sys, pathlib
p = pathlib.Path("CONTRIBUTING.md")
p.write_text(p.read_text().replace("__SETUP__", sys.argv[1]))
PY
    fi
    if [ "$PR" = 1 ] && [ "$DRY" != 1 ] && [ -n "$(git status --porcelain)" ]; then
      branch="chore/community-health"
      git checkout -B "$branch" >/dev/null 2>&1
      git add SECURITY.md CODE_OF_CONDUCT.md SUPPORT.md CONTRIBUTING.md .github 2>/dev/null
      git commit -q -m "docs: add security policy, contributing guide and issue templates" \
        && git push -q -u origin "$branch" \
        && gh pr create --title "docs: add security policy, contributing guide and issue templates" \
             --body "Adds SECURITY.md, CODE_OF_CONDUCT.md, SUPPORT.md, CONTRIBUTING.md, issue forms (blank issues off) and a pull request template. Reports go through GitHub private reporting; no personal contact details." \
             --head "$branch" 2>&1 | sed 's/^/    /'
      git checkout - >/dev/null 2>&1
    fi
  fi
  if [ "$SETTINGS" = 1 ]; then
    if command -v gh >/dev/null 2>&1; then apply_settings "$SLUG"; else say "  gh not installed: settings skipped"; fi
  fi
done
[ "$found" = 1 ] || say "No sethucms* repositories found in $HOME."
say ""
say "Done. Review with 'git status' in each repo. Nothing was committed unless you used --pr."
