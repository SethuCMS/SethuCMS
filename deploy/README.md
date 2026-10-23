# Deploy files

- `github-workflows/` : optional deploy workflows (Cloud Run, VPS). CI and releases are already in `.github/workflows/`. **GitHub only reads `.github/workflows/`, so copy one there to use it:**
  `cp deploy/github-workflows/deploy-cloud-run.yml .github/workflows/`
  They use version tags for actions (`actions/checkout@v4` …). Replace each with a commit SHA before relying on them.
- `compose.production.yml`, `Caddyfile`, `compose.env.example` : Postgres + gateway + optional worker + HTTPS on one server.

The compose stack is started and health-checked in CI (the Everything workflow). Caddy with a real domain is the part CI cannot check. To install on a server: `bash deploy/install-server.sh <domain> <image-version>`. Read docs 21 and 22 (in sethucms-docs) first.
