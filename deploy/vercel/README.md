# SethuCMS on Vercel (serverless)

The gateway runs as a Vercel function, and the admin app is served as static
files from the same address, so there is no cross-site setup.

State lives in Firestore. Any number of function instances can run at once: a
counter in `<prefix>_meta/state` goes up with every change, a change is saved in
a transaction that checks it, and each request first checks whether another
instance changed anything (`SETHUCMS_STATE_POLL_MS`, default 1000 ms; 0 checks
on every request).

## What does not work in this mode

These need a process that stays up, so the gateway answers `501 NOT_SUPPORTED`:
live events (`/v1/events`, preview events), the change feed (`/v1/changes`) and
webhooks (`/v1/admin/webhooks`). Also:

- Migrations that run longer than the function time limit are cut off.
- Rate limits and retried-request (idempotency) answers are kept per instance.
- Each instance keeps its own audit chain (the log shows them all).
- Only one gateway mode may use a state prefix at a time. Do not run
  `deploy/run-with-tunnel.sh` (single-gateway mode) and this deployment on the
  same prefix together; use `SETHUCMS_FIRESTORE_PREFIX` to separate them.

For live events and webhooks, run the long-lived gateway instead (see
`deploy/README.md`).

## Steps

1. Build the folder to deploy (from the repo root):
   ```
   node deploy/vercel/build.mjs
   ```
   It builds the gateway and the admin app, bundles the gateway into
   `deploy/vercel/out/api/index.mjs`, and writes `vercel.json` and `package.json`.
2. Log in and create the project (free Hobby plan; no card needed):
   ```
   cd deploy/vercel/out
   npx vercel login
   npx vercel link
   ```
3. Set the settings (reads `~/.config/sethucms/` and stores them as Sensitive):
   ```
   bash ../set-env.sh
   ```
4. Deploy:
   ```
   npx vercel deploy --prod
   ```
5. Check: `curl https://<your-project>.vercel.app/v1/health`, then open the
   address and sign in with the admin token from `~/.config/sethucms/gateway.env`.
6. Your own name: Vercel dashboard, Project, Settings, Domains, then add the
   DNS record it shows.

## Notes

- `vercel.json` asks for the Singapore region (`sin1`) to sit next to a
  Firestore in `asia-southeast1`. Change `regions` if your database is elsewhere.
- `maxDuration` is 30 seconds. If the deploy refuses it for your plan, lower it.
- A cold start loads the saved state once (about one to three seconds). Later
  requests on the same instance use the loaded copy.
- Never put secrets in `VITE_` variables: those are public in the browser.
