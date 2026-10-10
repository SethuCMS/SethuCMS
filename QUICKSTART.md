# Quick start

SethuCMS is free software (MIT licence) with **no warranty**. It is early: read "What is tested" before you put real data near it.

## What you need

- Node.js 22 or newer and pnpm 9 (`corepack enable`)
- The four repositories side by side in one folder: `sethucms`, `sethucms-adapter-sdk`, `sethucms-adapters`, `sethucms-admin`

## Run it on your machine (tested path)

```sh
cd sethucms
sh scripts/build-all.sh     # installs and builds all four; a few minutes the first time
sh scripts/run-local.sh     # http://127.0.0.1:8080 (set PORT=8090 if something else uses 8080)
```

The first start prints an **admin token once**. Copy it, open http://127.0.0.1:8080 and sign in. It starts with a demo connection so you can click around. Your data stays in `sethucms/.sethucms-data`.

## Connect your own database

In the admin app choose **Connections, New connection**, pick the database and fill in the form. Start **read-only**. Then expose one collection, create a draft, preview it and publish.

| Database | You need |
|---|---|
| PostgreSQL | host, database, a user with the fewest rights it can have |
| SQLite | set `SETHUCMS_SQLITE_DIR=/some/folder` before starting, then use a file name inside it |
| MySQL / MariaDB, MongoDB, Firestore | run `pnpm add mysql2` (or `mongodb`, `@google-cloud/firestore`) in `sethucms/apps/api` first |

## What is tested

- PostgreSQL 16, SQLite, MySQL 8, MariaDB 11 and MongoDB 7: the adapters run against the real servers in CI (the *Databases* workflow), one job per database.
- Firestore: tested against Google's local emulator. **Experimental.**
- The Docker image and the production compose stack are built, started and health-checked in CI (the *Everything* workflow).

Still early software: try a new database on a copy of your data first.

Details: `sethucms-docs/docs/18-adapters.md`.

## Before real use

Read `sethucms-docs/docs/15-deploy-production.md` (secrets, HTTPS, backups) and run `sh scripts/backup.sh` while the gateway is stopped. Run one gateway per data folder.

## Something wrong?

Open an issue with what you did, what you expected and what happened. Never paste tokens, passwords or database addresses. Security problems: see `SECURITY.md` and report them privately.
