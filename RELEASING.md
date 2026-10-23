# Releasing SethuCMS 0.1.0

First public release. Everything below was checked in a clean folder by packing
each package and installing the tarballs together: all ten packages import, and
the shared adapter conformance suite passes (memory and SQLite) from the
installed copies.

## Before anything is public

1. **Scan history for secrets.** Files are clean today, but old commits may not
   be. Run in each repo, before making it public:
   `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest detect --source /repo -v`
   (or install gitleaks). Anything it finds must be rotated, not just deleted.
2. **Check what git will add:** `git status` in all repos. No `.env`,
   `.sethucms-data/`, `node_modules/` or `dist/`.
3. **Remotes:** `git remote -v` in each repo. Fix any that still say `anydbcms-*`.
4. **GitHub:** turn on private vulnerability reporting (Settings, Security) in
   each repo. `SECURITY.md` points people there.

## npm setup (once)

1. Create the `@sethucms` organization at npmjs.com (free for public packages).
2. Turn on 2FA for your account (required to publish).
3. `npm login`

## Publish order (each depends on the one before)

Run `pnpm install && pnpm build` in each repo first. Use `pnpm publish`, not
`npm publish`: pnpm rewrites the `workspace:^` links to real versions.
Do a dry run of every package first (`--dry-run`), then the real thing.

```
cd ~/sethucms/packages/core            && pnpm publish --dry-run --no-git-checks && pnpm publish --no-git-checks
cd ~/sethucms-adapter-sdk              && pnpm publish --dry-run --no-git-checks && pnpm publish --no-git-checks
cd ~/sethucms-adapters/packages/sql-kit   && pnpm publish --no-git-checks
cd ~/sethucms-adapters/packages/postgres  && pnpm publish --no-git-checks
cd ~/sethucms-adapters/packages/mysql     && pnpm publish --no-git-checks
cd ~/sethucms-adapters/packages/sqlite    && pnpm publish --no-git-checks
cd ~/sethucms-adapters/packages/mongodb   && pnpm publish --no-git-checks
cd ~/sethucms-adapters/packages/firestore && pnpm publish --no-git-checks
cd ~/sethucms-adapters/packages/memory    && pnpm publish --no-git-checks
cd ~/sethucms-sdk-ts                   && pnpm publish --no-git-checks
```

`--no-git-checks` is only needed while you have uncommitted changes. Better:
commit and push first, then publish without it.

A published version can never be reused, even after unpublishing. If a publish
goes wrong, fix it and publish 0.1.1.

## After publishing

1. In a scratch folder: `npm install @sethucms/sdk @sethucms/adapter-postgres`
   and confirm they resolve. Open each package page on npmjs.com.
2. Remove the `pnpm.overrides` `link:` lines from `sethucms-adapter-sdk` and
   `sethucms-adapters` once their dependencies come from npm, then re-lock.
3. Tag each repo `v0.1.0` and create a GitHub release.
4. The gateway is not on npm (`@sethucms/api` is private). Ship it as the
   Docker image (see `deploy/`) until a `create-sethucms` command exists.

## Known limits to say plainly in the release notes

- Tested for real: SQLite, Postgres, MySQL, MariaDB. MongoDB and Firestore have
  only been run against stand-ins (FerretDB, a fake); run
  `sh scripts/test-real-servers.sh` with Docker to test them.
- The Docker image, compose file, Caddy config and CI workflows have not been
  run end to end.
- OIDC sign-in is tested against a fake identity provider only.
- No custom-role or webhook screens in the admin app yet.
