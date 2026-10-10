# SethuCMS

[![CI](https://github.com/SethuCMS/sethucms/actions/workflows/ci.yml/badge.svg)](https://github.com/SethuCMS/sethucms/actions/workflows/ci.yml) [![Databases](https://github.com/SethuCMS/sethucms/actions/workflows/databases.yml/badge.svg)](https://github.com/SethuCMS/sethucms/actions/workflows/databases.yml) [![CodeQL](https://github.com/SethuCMS/sethucms/actions/workflows/codeql.yml/badge.svg)](https://github.com/SethuCMS/sethucms/actions/workflows/codeql.yml) ![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

One CMS for every database. A security-first admin and content layer that connects to SQL, document, key-value and cloud-hosted databases through a common adapter contract.

**Works with:** ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white) ![MySQL](https://img.shields.io/badge/MySQL-4479A1?style=flat-square&logo=mysql&logoColor=white) ![MariaDB](https://img.shields.io/badge/MariaDB-003545?style=flat-square&logo=mariadb&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-003B57?style=flat-square&logo=sqlite&logoColor=white) ![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=flat-square&logo=mongodb&logoColor=white) ![Firestore](https://img.shields.io/badge/Firestore-FFCA28?style=flat-square&logo=firebase&logoColor=black)

<sub>Logos are trademarks of their owners and appear only to name the databases SethuCMS works with.</sub>

Design docs live in [`sethucms-docs`](https://github.com/sethucms/sethucms-docs).

> **Early software, free (MIT licence), no warranty.** The adapters run against real PostgreSQL, SQLite, MySQL, MariaDB and MongoDB servers, and against Google's Firestore emulator (experimental), in the *Databases* workflow. See [QUICKSTART.md](QUICKSTART.md) to try it and [docs 18](https://github.com/sethucms/sethucms-docs/blob/main/docs/18-adapters.md) for what each adapter was tested on.

## Layout

| Path | Purpose |
|---|---|
| `packages/core` | Content model, portable query AST, capabilities, permissions, cursors, errors, redaction |
| [sethucms-adapter-sdk](https://github.com/sethucms/sethucms-adapter-sdk) (separate repo) | The adapter contract, the safety guard every adapter runs behind, and the conformance test suite |
| [sethucms-adapters](https://github.com/sethucms/sethucms-adapters) (separate repo) | First-party adapters: memory, PostgreSQL, SQLite, MySQL/MariaDB, MongoDB, Firestore |
| [sethucms-sdk-ts](https://github.com/sethucms/sethucms-sdk-ts), [-python](https://github.com/sethucms/sethucms-sdk-python), [-dart](https://github.com/sethucms/sethucms-sdk-dart) (separate repos) | Client SDKs |
| [sethucms-adapter-template-python](https://github.com/sethucms/sethucms-adapter-template-python), [-go](https://github.com/sethucms/sethucms-adapter-template-go) (separate repos) | Starting points for adapters written in Python or Go |
| [`apps/api`](apps/api) | The gateway: one HTTP API for every connected database, with drafts, publishing, live preview and audit |
| [sethucms-admin](https://github.com/sethucms/sethucms-admin) (separate repo) | The admin app: connections, content studio, drafts, live preview, roles, audit log |
| `apps/worker` | Background jobs (planned) |

## Run it

Clone these repositories **side by side in the same folder** (they link to each other by folder until the packages are published):

```
sethucms  sethucms-adapter-sdk  sethucms-adapters  sethucms-admin
```

```sh
cd sethucms
sh scripts/build-all.sh     # installs and builds everything, in the right order
sh scripts/run-local.sh     # http://127.0.0.1:8080
```

The first start prints an admin token once. Paste it on the sign-in screen. A demo connection with sample articles is included.
Add a PostgreSQL database under **Connections**. See [`apps/api/README.md`](apps/api/README.md) for settings, the API and the security model.

Requires Node 20 or newer and pnpm 9.

## Develop

```sh
pnpm install
pnpm build
pnpm test
```

## Status

Early. Implemented and tested: core, adapter SDK, six adapters (memory, PostgreSQL, SQLite, MySQL/MariaDB, MongoDB, Firestore; the last three only against compatible servers or fakes), the TypeScript SDK, and the gateway with the admin app (connections, content, drafts and publish, live preview, tokens, audit, moving data between databases). Not yet: the worker, single sign-on, and running several gateways at once. See the roadmap in the docs repo.

## Support the project

SethuCMS is free and stays free. If it is useful to you, you can help keep it maintained through the **Sponsor** button on this repository. What the money pays for, and what sponsors do and do not get, is in [docs 20](https://github.com/sethucms/sethucms-docs/blob/main/docs/20-sponsorship.md).
