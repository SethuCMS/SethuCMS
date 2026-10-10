# CodeQL: newer action version (v3 is being retired), explicit no-build mode
for r in sethucms sethucms-admin; do
cat > ~/$r/.github/workflows/codeql.yml <<'YML'
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "17 3 * * 1"
permissions:
  contents: read
  security-events: write
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v4
        with:
          languages: javascript-typescript
          build-mode: none
      - uses: github/codeql-action/analyze@v4
YML
done
# Dependabot: group minor/patch updates into one pull request, fewer open at once
for r in sethucms sethucms-admin sethucms-adapters sethucms-adapter-sdk sethucms-sdk-ts; do
cat > ~/$r/.github/dependabot.yml <<'YML'
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: weekly
    open-pull-requests-limit: 3
    groups:
      minor-and-patch:
        update-types: ["minor", "patch"]
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: monthly
    open-pull-requests-limit: 2
    groups:
      actions:
        patterns: ["*"]
YML
done
cat >> ~/sethucms/.github/dependabot.yml <<'YML'
  - package-ecosystem: docker
    directory: "/docker"
    schedule:
      interval: monthly
    open-pull-requests-limit: 2
YML
