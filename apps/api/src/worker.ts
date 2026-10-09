/**
 * A webhook delivery worker that runs on its own, without the HTTP gateway.
 *
 *   SETHUCMS_STATE_URL=postgres://...  SETHUCMS_VAULT_KEY=...  \
 *     node dist/src/worker.js
 *
 * Use the same values as the gateways.
 *
 * Needs the shared PostgreSQL state (it reads webhooks from it and takes
 * deliveries from its queue). Start the gateways with SETHUCMS_WORKER=off so
 * only workers deliver. Several workers can run at once: each delivery is
 * taken by exactly one of them.
 */
// Unlike main.ts this process serves no HTTP; it only delivers webhooks.
import { configFromEnv } from './config.js';
import { NetworkGuard } from './security/network-guard.js';
import { loadSecrets } from './security/secrets.js';
import { Vault } from './security/vault.js';
import { createLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { PostgresChangeStore } from './changes/postgres.js';
import { DeliveryWorker } from './changes/worker.js';
import {
  OUTBOX_CHANNEL,
  PostgresStateStore,
  SharedDb,
} from './store/postgres.js';

const config = configFromEnv(process.env);
if (!config.stateUrl) {
  process.stderr.write(
    'The worker needs SETHUCMS_STATE_URL (the shared PostgreSQL database the gateways use).\n',
  );
  process.exit(1);
}
const logger = createLogger({
  level: config.logLevel ?? 'info',
  format: config.logFormat ?? 'json',
});
// Same vault key as the gateways, so this worker can decrypt the webhook
// signing secrets they stored. `production: true` refuses weak defaults.
const secrets = await loadSecrets({
  env: process.env,
  dataDir: undefined,
  production: true,
});
const db = await SharedDb.open({ url: config.stateUrl });
const state = await PostgresStateStore.open(
  db,
  config.statePollMs === undefined ? {} : { pollMs: config.statePollMs },
);
const metrics = new Metrics();
// `webhooks` is a function so each pass sees the latest synced config.
// The guard blocks SSRF: deliveries to private addresses are refused
// unless explicitly allowed.
const worker = new DeliveryWorker({
  store: new PostgresChangeStore(db),
  webhooks: () => state.read().webhooks,
  vault: new Vault(secrets.vaultKey),
  guard: new NetworkGuard({
    allowPrivateNetworks: config.allowPrivateNetworks,
  }),
  logger,
  results: metrics.counter(
    'sethucms_webhook_deliveries_total',
    'Webhook delivery attempts, by result.',
  ),
});
// Wake immediately when a gateway enqueues a delivery; polling is a backup.
db.listen(OUTBOX_CHANNEL, () => worker.nudge());
worker.start();
logger.info({ event: 'worker.start' });

// Stop the worker first so in-flight deliveries finish before the DB closes.
let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await worker.stop();
  state.stop();
  await db.close();
  metrics.close();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
