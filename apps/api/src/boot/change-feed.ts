/**
 * The change feed: every change made here is numbered and queued for matching
 * webhooks, in order, and a worker delivers them.
 */
import type { GatewayConfig } from '../config.js';
import { EventBus } from '../events.js';
import { type Logger } from '../logger.js';
import { Metrics } from '../metrics.js';
import { type Services } from '../routes/services.js';
import { NetworkGuard } from '../security/network-guard.js';
import { Vault } from '../security/vault.js';
import { type StateStore } from '../store/state.js';
import { OUTBOX_CHANNEL, SharedDb } from '../store/postgres.js';
import { type ChangeStore } from '../changes/store.js';
import { DeliveryWorker, matchesWebhook } from '../changes/worker.js';
import { registerChangeRoutes } from '../routes/changes.js';

export interface ChangeFeed {
  worker: DeliveryWorker | undefined;
  stopOutbox: (() => void) | undefined;
  /** Resolves when every change seen so far has been numbered and queued. */
  drain: () => Promise<unknown>;
}

/**
 * Start numbering changes and delivering webhooks. Returns what the gateway
 * needs to stop them again.
 */
export function startChangeFeed(input: {
  config: GatewayConfig;
  services: Services;
  metrics: Metrics;
  changes: ChangeStore;
  store: StateStore;
  vault: Vault;
  networkGuard: NetworkGuard;
  logger: Logger;
  events: EventBus;
  db: SharedDb | undefined;
}): ChangeFeed {
  const {
    config,
    services,
    metrics,
    changes,
    store,
    vault,
    networkGuard,
    logger,
    events,
    db,
  } = input;
  // The change feed: every change made here is numbered and queued for matching
  // webhooks, in order.
  const deliveries = metrics.counter(
    'sethucms_webhook_deliveries_total',
    'Webhook delivery attempts, by result (delivered, retry, dead).',
  );
  const worker =
    config.worker === false
      ? undefined
      : new DeliveryWorker({
          store: changes,
          webhooks: () => store.read().webhooks,
          vault,
          guard: networkGuard,
          logger,
          results: deliveries,
        });
  // Chain appends so change numbers are assigned in the order events happen.
  let feed: Promise<unknown> = Promise.resolve();
  events.subscribeLocal((event) => {
    feed = feed
      .then(async () => {
        const ids = Object.values(store.read().webhooks)
          .filter((webhook) => matchesWebhook(webhook, event))
          .map((webhook) => webhook.id);
        await changes.append(event, ids);
        if (ids.length > 0) {
          worker?.nudge();
        }
      })
      .catch((error: unknown) =>
        logger.error({
          event: 'changes.append_failed',
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
  });
  // Another gateway queued a change: wake our delivery worker.
  const stopOutbox = db?.listen(OUTBOX_CHANNEL, () => worker?.nudge());
  registerChangeRoutes(services, {
    vault,
    guard: networkGuard,
    production: config.production,
    onChange: () => worker?.nudge(),
  });
  worker?.start();
  return { worker, stopOutbox, drain: () => feed };
}
