# @sethucms/api: the gateway

One HTTP API in front of every connected database. Editors, the admin app and the client SDKs all go
through it, and it is the only thing that ever holds database credentials.

```
 admin app / SDKs / your website
            │  HTTPS, API token
            ▼
        ┌─────────┐   permissions, validation, signed cursors,
        │ gateway │   drafts, audit, rate limits
        └───┬─────┘
   ┌────────┼─────────┐
   ▼        ▼         ▼        one adapter per connection, all live at once
 memory  PostgreSQL  (more adapters plug in here)
```

Plain `node:http`, no web framework. About 3,000 lines of TypeScript, every file small enough to read.

## Run it

From the `sethucms` repository (the sibling repositories must sit next to it, see the top-level README):

```sh
sh scripts/build-all.sh
sh scripts/run-local.sh
```

Open <http://127.0.0.1:8080>. The first start prints an admin token once. Paste it on the sign-in screen.
A "Demo content" connection with sample articles is added so you can try everything straight away.

Run only the gateway during development: `pnpm --filter @sethucms/api build && node apps/api/dist/src/main.js`.

## Settings

All settings are environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `8080`, `127.0.0.1` (`0.0.0.0` in production) | Where it listens |
| `NODE_ENV=production` | | Requires the secrets and an admin token, and turns off demo data and private-network access |
| `SETHUCMS_VAULT_KEY`, `SETHUCMS_CURSOR_SECRET`, `SETHUCMS_PREVIEW_SECRET` | generated locally | Three separate secrets (`openssl rand -base64 32`) |
| `SETHUCMS_ADMIN_TOKEN` | generated locally | The first admin's API token |
| `SETHUCMS_DATA_DIR` | `./.sethucms-data` | Saved state. `memory` keeps nothing on disk |
| `SETHUCMS_ADMIN_DIR` | none | Built admin app to serve at `/` |
| `SETHUCMS_ALLOWED_ORIGINS` | none | Browser origins allowed to call the API (CORS) |
| `SETHUCMS_ALLOW_PRIVATE_NETWORKS` | on locally, off in production | Let connections reach private addresses |
| `SETHUCMS_TRUST_PROXY` | off | Believe `X-Forwarded-For` |

## The API

Every answer is JSON. Errors always look like `{ "error": { "code", "message", "details?", "requestId" } }`.
Send `Authorization: Bearer <token>`. This is the same contract the SDKs use.

| Route | Who | What |
|---|---|---|
| `GET /v1/health`, `GET /v1/ready` | anyone | Liveness and readiness |
| `GET /v1/me` | any token | Who am I |
| `GET /v1/connections` | any token | Connections |
| `GET /v1/connections/:c/collections` | any token | Collections that are in the API, with fields |
| `GET /v1/connections/:c/collections/:n` | any token | Full definition: which fields this token may edit, what actions it may take |
| `GET  …/records` | any token | List. Query: `filter` (JSON), `sort` (`-created_at,name`), `fields`, `limit`, `cursor` |
| `GET  …/records/:id` | any token | One record |
| `POST …/records`, `PATCH …/records/:id`, `DELETE …/records/:id` | editor | Write. Send `Idempotency-Key` to make retries safe |
| `GET/POST …/drafts`, `GET/PATCH/DELETE …/drafts/:id` | editor | Drafts. `PATCH` needs the `version` you last saw |
| `POST …/drafts/:id/publish` | editor | Write the draft to the database. Body `{ "version", "force"? }` |
| `POST …/drafts/:id/preview-link` | editor | A signed link that shows the draft, valid 15 minutes |
| `GET /v1/preview/:token`, `GET /v1/preview/:token/events` | the link | The draft merged over the published record, and a live stream of changes |
| `GET /v1/events` | any token | Live stream of changes made through the gateway (ids only) |
| `/v1/admin/connections…`, `/v1/admin/tokens…`, `GET /v1/admin/audit`, `GET /v1/admin/overview` | admin | Manage connections, tokens, audit log |

### Drafts and publishing

A draft is an edit that has **not** been written to your database. Drafts live in the gateway's own store,
encrypted, so a half-finished article never appears in a production table.

- Two people saving the same draft: each save carries the `version` it started from. A stale version is refused with `409`.
- Someone changing the live record while a draft is open: the draft remembers a fingerprint of the record it started from. Publishing refuses with `409` (`details.reason = "record_changed"`) unless you send `force: true`.
- Publishing is claimed first, so a double click cannot publish twice.
- Drafts may be incomplete. Required fields are checked when you publish.

### Live preview

`POST …/preview-link` returns `{ path, expiresAt }`. Open `path` to read the merged record, or
`path + "/events"` as a server-sent event stream (`EventSource` works). Your website can use that address
directly: it needs no API token. The link is signed, expires, is tied to one draft and to the token that created it,
and shows only what that token may read. If that token is revoked, the link stops working.

### Live events

Changes made **through the gateway** are announced immediately. Changes made directly in a database by other tools
are not seen. Events contain ids only, never field values.

## Several databases at once

Each connection has its own adapter, connection pool, capabilities and list of exposed collections. They are opened
when first used, kept open, and isolated from each other. A new connection starts **read-only** and with **every
collection hidden**. An admin reviews the collections and turns on the ones editors and the API may use.

Database types are listed in `src/connections/adapters.ts`. Today: `memory` (demo) and `postgres`.
A new adapter is one entry there plus a package from `sethucms-adapters`.

## Security model

| Concern | What the gateway does |
|---|---|
| Authentication | API tokens. Only SHA-256 hashes are stored. Constant-time comparison. Revoking takes effect immediately |
| Authorization | Roles (admin, editor, viewer) feed the permission rules from `@sethucms/core`: field masking, row filters, write rules. Filtering or sorting on a field you may not read is refused |
| Database passwords | Encrypted with AES-256-GCM, bound to the connection id, never returned by any route, never logged |
| Drafts at rest | Encrypted the same way |
| SQL injection | The portable query is validated against the content model; adapters send values as parameters |
| Read-only | The default. Enforced by the guard and, for PostgreSQL, again by the database session itself |
| Outbound connections | The host name is resolved and checked first. Cloud metadata and link-local addresses are always blocked. Private ranges are blocked in production unless allowed |
| Cursors | Signed, expire after 24 hours, and only work for the query that produced them |
| Errors | One standard body. Database messages, hosts and SQL never reach clients (`INTERNAL` is a fixed message) |
| Abuse | Rate limits per address and per token, 1 MB body limit, 30 s request timeout, caps on open streams |
| Browsers | Strict CORS allow-list. The API sends `no-store`, `nosniff`, a locked-down CSP and no referrer. The admin is served with its own strict CSP |
| Secrets in settings | Connection settings containing keys such as `password` or `token` are refused with a pointer to `credentials` |
| Audit | Every change is recorded with the actor and a redacted before/after of the changed fields |
| Startup | Production refuses to start without its secrets and an admin token |
| Idempotency | `Idempotency-Key` on writes replays the first answer. Reusing a key for a different request is refused |

## Limits today (be aware)

- **One gateway process.** State is a JSON file written atomically with owner-only permissions. To run several
  gateways, implement `StateStore` (`src/store/state.ts`) on a shared database. Rate limits, idempotency keys and
  live-event delivery are also per process.
- **Tokens and roles only.** No single sign-on (OIDC) yet, and no per-collection custom roles. The core permission
  engine supports them; the gateway currently maps three fixed roles onto it.
- **Events only see changes made through the gateway.** No change streams from the databases themselves yet.
- **DNS rebinding.** The network guard checks what a name resolves to at connection time. A hostile DNS server that
  changes its answer between the check and the connection is not defended against. Use private networks plus
  allow-listed egress (see `sethucms-infra`) for strong isolation.
- **Adapters run in this process**, except `grpc` connections, which talk to a separate adapter service (doc 23).
- **Several gateways** share state through PostgreSQL (`SETHUCMS_STATE_URL`, doc 22). Rate limits stay per gateway.
- **State in Firestore** (one gateway): set `SETHUCMS_FIRESTORE_PROJECT` and the gateway keeps its connections, tokens, drafts, audit log and change feed in your Firestore instead of files. A lease in the database refuses a second gateway; a crashed gateway's lease expires after 30 seconds. Secrets (`SETHUCMS_VAULT_KEY`, `SETHUCMS_CURSOR_SECRET`, `SETHUCMS_PREVIEW_SECRET`, `SETHUCMS_ADMIN_TOKEN`) still come from the environment. Not combinable with `SETHUCMS_STATE_URL`; for several gateways use PostgreSQL.

  | Variable | Meaning |
  | --- | --- |
  | `SETHUCMS_FIRESTORE_PROJECT` | Google Cloud project id. Turns this mode on. |
  | `SETHUCMS_FIRESTORE_PREFIX` | Collection-name prefix, default `sethucms`. Use one per environment. |
  | `SETHUCMS_FIRESTORE_CREDENTIALS_JSON` | Service-account key (JSON text) for hosts outside Google Cloud, such as Fly.io. Omit on Google Cloud. |
  | `SETHUCMS_FIRESTORE_EMULATOR_HOST` | `host:port` of the local emulator, development only. |

  The change feed is saved every few seconds, so a crash can lose the last few seconds of changes; PostgreSQL has no such gap.
- **Serverless** (Vercel and similar): add `SETHUCMS_SERVERLESS=1` to the Firestore settings. Many short-lived instances then share the state: a version counter in Firestore, a save that checks it, and a check for other instances' changes at the start of each request (`SETHUCMS_STATE_POLL_MS`, default 1000, 0 = every request). There is no lease. Live events, the change feed and webhooks answer `501 NOT_SUPPORTED` in this mode, and the delivery worker is off. Entry point: `src/serverless.ts`; the Vercel setup is in `deploy/vercel/README.md`.

## Tests

```sh
pnpm --filter @sethucms/api test
```

Runs about 50 tests against the real HTTP server (auth, records, cursors, drafts, preview, events, roles,
read-only, network guard, encryption, persistence). To also run the tests against a real PostgreSQL:

```sh
SETHUCMS_TEST_PG_HOST=127.0.0.1 SETHUCMS_TEST_PG_PORT=5432 SETHUCMS_TEST_PG_DB=cms_test \
SETHUCMS_TEST_PG_USER=postgres SETHUCMS_TEST_PG_PASSWORD=secret pnpm --filter @sethucms/api test
```

The PostgreSQL test creates and drops its own table `gw_posts`.

## Layout

| Path | What it does |
|---|---|
| `src/gateway.ts` | Wires everything and runs the request pipeline |
| `src/routes/` | `content.ts` (records, drafts, preview, events), `admin.ts` (connections, tokens, audit) |
| `src/content/` | `records.ts`, `drafts.ts`, `access.ts`: the rules for reading and writing content |
| `src/connections/` | The registry of live connections, the adapter list, demo data |
| `src/security/` | Vault, secrets, network guard, rate limiter, idempotency, preview tokens |
| `src/store/state.ts` | Saved state (file or memory) |
| `src/auth.ts`, `src/audit.ts`, `src/events.ts` | Tokens and roles, audit log, live-event bus |
| `src/http/` | Router, JSON responses, server-sent events, static admin files |
