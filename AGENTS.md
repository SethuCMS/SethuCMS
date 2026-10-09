# AGENTS.md — SethuCMS

Read this first. It tells you what this project is, how the repositories fit together, how to build and test, what must never be broken, and how it is deployed.

## What this is

SethuCMS is a security-first CMS that sits on top of any database. A **gateway** (`apps/api`) is the only thing that talks to databases. Clients (the admin app, SDKs, websites) talk only to the gateway, through one REST API. The gateway applies permissions, keeps drafts, and writes an audit log.

Full design: the `sethucms-docs` repository (`docs/01` to `docs/15`). The gateway: `docs/12-gateway.md`. Drafts: `docs/13`. Build and run: `docs/14`. Production: `docs/15`.

## The repositories (they live side by side in one folder)

| Folder | What it is | Language |
| --- | --- | --- |
| `sethucms` | `packages/core` (content model, permissions, query rules, errors) and `apps/api` (the gateway) | TypeScript |
| `sethucms-adapter-sdk` | The adapter contract, the guard layer, the conformance test kit | TypeScript |
| `sethucms-adapters` | First-party adapters: `memory`, `postgres`, `sqlite`, `mysql`, `mongodb`, `firestore`, and the shared `sql-kit` | TypeScript |
| `sethucms-admin` | The admin app | React 19, Vite |
| `sethucms-sdk-ts`, `-python`, `-dart` | Client SDKs | TS, Python, Dart |
| `sethucms-adapter-template-python`, `-go` | Starting points for adapters in other languages (gRPC) | Python, Go |
| `sethucms-infra` | Docker, compose, Kubernetes, Terraform | YAML, HCL |
| `sethucms-docs` | Documentation, schemas, LaTeX/PDF | Markdown, LaTeX |

Repositories link to each other **by folder** (`link:../sethucms/packages/core` and similar) until the packages are published. Never move or rename the folders. Dependency order: core, adapter-sdk, adapters, gateway, admin.

## Commands

Node 22 and pnpm 9 are the standard. (Bun starts the gateway but is not the supported path.)

```sh
cd sethucms
sh scripts/build-all.sh      # install and build everything in order
sh scripts/run-local.sh      # http://127.0.0.1:8080, prints an admin token once
pnpm --filter @sethucms/core test      # 29 tests
cd apps/api && pnpm test               # 106 tests with every database variable set (fewer are skipped otherwise): SETHUCMS_TEST_PG_HOST/PORT/DB/USER/PASSWORD, SETHUCMS_TEST_PG_URL, SETHUCMS_TEST_MYSQL_URL, SETHUCMS_TEST_MONGO_URL
cd ../../../sethucms-admin && pnpm typecheck && pnpm build:embedded
```

Run the tests for the package you changed before you say you are done. State what you ran and what you could not run.

## How a request flows (apps/api)

request id, CORS allow-list, route lookup (404/405), IP rate limit, token auth, per-token rate limit, idempotency key, handler, standard error body. Handlers go through `GuardedAdapter` and the core permission engine (`resolveAccess`, `restrictQuery`, `maskRecord`, `assertWritable`). Source: `apps/api/src/gateway.ts`, `routes/`, `content/`, `connections/`, `security/`, `store/`.

## Rules that must not be broken

These are the security properties of the product. A change that weakens one is a bug, even if tests pass.

1. **Clients never reach a database directly.** Only the gateway holds credentials.
2. **Every read and write goes through the permission engine and `GuardedAdapter`.** Do not add a route that calls an adapter directly. The one exception is the admin-only migration engine (`src/migration/`), which uses `registry.raw()` so it can copy collections that are hidden from editors; it validates every record itself, never writes to the source, and must stay admin-only. Do not use `registry.raw()` anywhere else.
3. **Connections are read-only by default, and every collection is hidden until an admin exposes it.**
4. **Secrets are encrypted** with the vault (AES-256-GCM, bound to the record id). Never log, return or store a credential, token or connection string in plain text. Use the redaction helpers in core.
5. **Tokens are stored as SHA-256 hashes and compared in constant time.**
6. **Database error text never reaches the client.** Errors become the standard body; unexpected errors are `INTERNAL` with a generic message.
7. **Unknown fields are rejected with 400** (`rejectUnknownFields`) before the writability check (403).
8. **No raw SQL string building.** Adapters use parameters and quoted identifiers only. The live PostgreSQL test checks injection safety.
9. **The network guard** always blocks cloud-metadata and link-local addresses, and private ranges unless allowed.
10. **Drafts are encrypted, versioned, and conflict-checked.** Publish claims the draft first (no double publish) and compares the record fingerprint unless `force` is set.
11. **Production refuses to start without** the vault key, cursor secret, preview secret and an admin token.
12. **No new dependency** without a reason. Prefer the Node standard library. The gateway has no web framework on purpose.

## Migration (apps/api/src/migration)

`plan.ts` checks a request and decides how collections map (pure, no database calls). `manager.ts` runs the copy in the background, one job at a time. Routes are under `/v1/admin/migrations`. See `sethucms-docs/docs/17-migration.md`.

- Plans must stay honest: anything that would lose data or write a wrong value is a blocking problem, not a warning.
- Record values never go into logs, audit entries or job errors.
- References are found from `field.references` **or** a many-to-one relation to the other collection's key (PostgreSQL reports foreign keys as relations). Handle both.
- It copies records only. It does not create tables.
- `createMissing` creates target tables/collections from the source definition (reference order, then `rediscover`, then `finishBulkLoad`). Jobs are saved to the data folder and recovered as *interrupted* after a restart.
- Verified: SQLite → SQLite, PostgreSQL 16, MariaDB 10.11, MySQL 8.0, Dolt, FerretDB, Firestore fake. PostgreSQL 16 → PostgreSQL 16. Not verified: real MongoDB, real Firestore (`sh scripts/test-real-servers.sh` runs them in Docker; never run yet).

## Logging and monitoring

Logs go to **stderr** (the banner is stdout). See `sethucms-docs/docs/16-logging-and-monitoring.md`. Never log bodies, query strings or record values. New metrics need bounded labels.

## Conventions

- Plain, readable code with short comments that say *why*. No clever one-liners.
- Error messages say what happened and how to fix it. They never apologise and never leak internals.
- UI words: sentence case, plain verbs, the same name for an action everywhere (Publish produces "Published").
- Tests are `node:test` files under `tests/`, run after `tsc`. Add a test with every fix.
- Fonts are bundled (`@fontsource`), never loaded from the internet; the gateway sends a strict content security policy.

## Gotchas (each of these has already caused a bug)

- Running `npm i` inside a repo can delete the folder links in `node_modules/@sethucms`. Use pnpm, and rebuild with `scripts/build-all.sh` if links vanish.
- A draft only checks required fields at publish time, not while saving.
- `reference` fields accept a string or a safe integer.
- Seeded demo data exists only when `SETHUCMS_SEED_DEMO` is on (default on locally, off in production).
- `GET /v1/events` shows only changes made through the gateway, not direct database changes.

## What is not built yet (do not pretend it is)

Custom roles in the gateway (three fixed roles), native database change capture (the change feed sees only changes made through the gateway), a webhook screen in the admin app, SSE `Last-Event-ID` replay, and shared rate limits (per gateway). Single sign-on, shared state with several gateways, the worker and gRPC adapters exist (docs 21-24) but were tested only against a fake identity provider, Postgres 16, in-process gRPC and a Python example server; the deploy workflows (`deploy/`) have never been run. Never claim more.

**Adapters and what they were really tested on** (doc 18): SQLite, PostgreSQL 16, MariaDB 10.11 and MySQL 8.0 against the real thing; MongoDB only against FerretDB 1.24; Firestore only against our own in-memory fake. Say so whenever you mention them. The SQLite adapter needs Node 22.5+.

## Working agreements with the owner

- **Do not `git commit` or `git push`** unless the owner asks. The owner reviews and commits.
- Files under `.github/` cannot be written by some tools; workflows are kept in `sethucms/ci-workflows/` and copied in with `sh scripts/install-ci.sh`.
- Say plainly what was verified and what was not. Local tests passing is not the same as working in production.
