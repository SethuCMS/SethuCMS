# Deploy files

- `github-workflows/` : CI, image release, Cloud Run, VPS. **GitHub only reads `.github/workflows/`, so copy them there:**
  `mkdir -p .github/workflows && cp deploy/github-workflows/*.yml .github/workflows/`
  They use version tags for actions (`actions/checkout@v4` …). Replace each with a commit SHA before relying on them.
- `compose.production.yml`, `Caddyfile`, `compose.env.example` : Postgres + gateway + optional worker + HTTPS on one server.

All of this is written but has not been run. Read docs 21 and 22 (in sethucms-docs) first.
