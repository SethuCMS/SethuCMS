# Contributing

Thanks for helping. The project is MIT licensed and contributions are welcome.

## Set up

Clone the repos side by side (`sethucms`, `sethucms-adapter-sdk`,
`sethucms-adapters`, `sethucms-admin`, `sethucms-sdk-ts`), then in each:

```
pnpm install
pnpm build
pnpm test
```

Tests for MySQL, Postgres, MongoDB and Firestore run only when you set their
`SETHUCMS_TEST_*` variables (see the test file headers). Without them they skip.

## Before you open a pull request

- Keep changes small and focused, with a test for new behaviour.
- Run Prettier (`.prettierrc.json` is in each repo) and make sure `pnpm test` passes.
- Braces on every `if`, short readable functions, and a comment for anything
  security-relevant that is not obvious.
- Security fixes: report privately first (see `SECURITY.md`).

## New database adapters

Implement the adapter contract in `@sethucms/adapter-sdk` and run its shared
conformance suite (`@sethucms/adapter-sdk/testing`). An adapter that passes the
suite behaves like every other one.
