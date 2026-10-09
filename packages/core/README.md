# @sethucms/core

Dependency-free core of SethuCMS (Node 20+, Web Crypto only). Every adapter and the API build on it.

| Module | Responsibility |
|---|---|
| `errors` | Error codes, HTTP mapping, `toApiError` (never leaks INTERNAL details) |
| `field-types` | Canonical types, operators per type, value checks |
| `content-model` | `defineCollection`, `ContentModel`, `validateRecord` |
| `capabilities` | Capability matrix, restrictive defaults, per-database presets |
| `query-ast` | `parseQuery` for untrusted input, builders, hard limits |
| `query-validate` | Validate against introspected metadata; `planQuery` refuses unsupported queries |
| `pagination` | HMAC-signed, query-bound, expiring, rotatable cursors |
| `permissions` | Role merge, row filters, field mask/hide, anti-probing `restrictQuery` |
| `redact` | Secret redaction for logs and audit diffs |

## Security properties (tested)

- Field and collection names come only from the introspected definition; user strings are never interpolated.
- Object-valued filter values (`{"$ne": null}`) and unknown keys are rejected.
- Offset pagination is refused; cursors are tamper-proof and bound to the query that produced them.
- Row filters are ANDed onto every query; masked or hidden fields cannot be filtered, sorted or projected.
- Unsupported capabilities raise `CAPABILITY_UNSUPPORTED` instead of degrading silently.

```sh
pnpm --filter @sethucms/core test
```

## Quick example

```ts
import {
  defineCollection, parseQuery, planQuery, resolveAccess, restrictQuery, PRESETS,
} from '@sethucms/core';

// 1. Describe a collection (normally produced by introspecting the database).
const posts = defineCollection({
  name: 'posts',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'title', type: 'string', required: true },
    { name: 'authorEmail', type: 'string' },
  ],
  relations: [],
});

// 2. Parse the untrusted request body. Throws VALIDATION_FAILED if anything looks wrong.
const query = parseQuery({ collection: 'posts', filter: { field: 'title', op: 'startsWith', value: 'Hello' } });

// 3. Apply what this user may see, then check the database can run it.
const access = resolveAccess([{ action: 'read', fieldRules: { authorEmail: { read: 'hide' } } }], posts, 'read');
const safeQuery = restrictQuery(query, access);
planQuery(safeQuery, posts, PRESETS.sql); // throws CAPABILITY_UNSUPPORTED if it cannot run
```

## How to read the code

Start with the file headers; each one explains its module in plain words. A good reading order:
`errors.ts` -> `field-types.ts` -> `content-model.ts` -> `query-ast.ts` -> `query-validate.ts` -> `permissions.ts` -> `pagination.ts`.
Tests in `tests/` double as examples of what is accepted and what is rejected.
