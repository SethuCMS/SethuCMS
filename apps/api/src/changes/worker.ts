/**
 * The delivery worker: sends queued change events to webhooks.
 *
 * Delivery is at-least-once. A receiver may see the same event twice (after a
 * timeout, for example) and may see events out of order, so it should use the
 * `id` / `seq` fields to ignore repeats.
 *
 * Every request is signed:  X-Sethu-Signature: t=<unix seconds>,v1=<hex>
 * where v1 = HMAC-SHA256(secret, "<t>.<raw body>"). Receivers should reject a
 * signature older than a few minutes.
 *
 * Safety: the address is vetted by the network guard for every attempt and the
 * connection goes to the vetted address (so a changing DNS answer cannot
 * redirect it), redirects are never followed, a request is cut off after 10
 * seconds, and the receiver's answer is never stored, only its status code.
 */
import { createHmac } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CmsEvent } from '../events.js';
import type { Logger } from '../logger.js';
import type { Counter } from '../metrics.js';
import type { NetworkGuard } from '../security/network-guard.js';
import type { Vault } from '../security/vault.js';
import type { StoredWebhook } from '../store/state.js';
import { BACKOFF_SECONDS, type ChangeStore, type Outcome } from './store.js';

// Tunables: per-request timeout, batch size, concurrency, and how long a
// claimed delivery is reserved before another worker may retry it.
const TIMEOUT_MS = 10_000;
const BATCH = 20;
const PARALLEL = 5;
const LEASE_MS = 60_000;

/** Dependencies for `DeliveryWorker`; injected so tests can fake them. */
export interface WorkerDeps {
  store: ChangeStore;
  /** The current webhooks (read each time, so changes apply at once). */
  webhooks(): Record<string, StoredWebhook>;
  vault: Vault;
  guard: NetworkGuard;
  logger: Logger;
  results?: Counter;
  /** Poll this often when nothing wakes the worker. Default 2000 ms. */
  pollMs?: number;
  /**
   * Seconds to wait before each retry. Default BACKOFF_SECONDS (tests use short
   * ones).
   */
  backoffSeconds?: number[];
}

/**
 * Does this webhook want this event?
 *
 * Checks, in order: active flag, subscribed event types, and the optional
 * connection and collection scope. Events with no collection (such as
 * connection changes) never match a collection-scoped webhook.
 */
export function matchesWebhook(
  webhook: StoredWebhook,
  event: CmsEvent,
): boolean {
  if (!webhook.active) {
    return false;
  }
  if (!webhook.events.includes('*') && !webhook.events.includes(event.type)) {
    return false;
  }
  if (
    webhook.connectionId &&
    'connectionId' in event &&
    event.connectionId !== webhook.connectionId
  ) {
    return false;
  }
  if (
    webhook.collection &&
    (!('collection' in event) || event.collection !== webhook.collection)
  ) {
    return false;
  }
  return true;
}

/**
 * Compute the `X-Sethu-Signature` header value.
 *
 * The timestamp is inside the signed text so a captured request cannot be
 * replayed later with a fresh time; receivers should enforce a max age.
 *
 * @param secret The webhook's plain signing secret.
 * @param timestamp Unix seconds.
 * @param body Exact raw request body that will be sent.
 */
export const sign = (secret: string, timestamp: number, body: string): string =>
  `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/**
 * Build the JSON body. `id` is stable per event, so receivers can
 * de-duplicate repeated (at-least-once) deliveries.
 */
export function payloadFor(seq: number, at: string, event: CmsEvent): string {
  return JSON.stringify({ id: `evt_${seq}`, seq, at, ...event });
}

/**
 * Polls the queue and delivers due events to webhooks, with retries.
 *
 * Safe to run in several processes at once: the store leases each
 * delivery to one worker at a time.
 */
export class DeliveryWorker {
  private timer: NodeJS.Timeout | undefined;
  // `running` stops overlapping ticks; `stopped` ends the loop for good.
  private running = false;
  private stopped = false;
  private pruneAt = 0;

  constructor(private readonly deps: WorkerDeps) {}

  /** Begin polling. Each pass runs to completion before the next is set. */
  start(): void {
    const loop = (): void => {
      if (this.stopped) {
        return;
      }
      void this.tick().finally(() => {
        if (this.stopped) {
          return;
        }
        this.timer = setTimeout(loop, this.deps.pollMs ?? 2000);
        this.timer.unref();
      });
    };
    loop();
  }

  /** Wake the worker now (a new event was queued). */
  nudge(): void {
    if (this.stopped || this.running) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.start(), 0);
    this.timer.unref();
  }

  /** Stop polling and wait for any in-flight pass to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Deliver everything that is due. Exposed for tests. */
  async tick(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    let sent = 0;
    try {
      for (;;) {
        // Claim in batches; each delivery is leased, so a crash mid-send means
        // it is retried later rather than lost.
        const due = await this.deps.store.claim(BATCH, LEASE_MS);
        if (due.length === 0) {
          break;
        }
        for (let i = 0; i < due.length; i += PARALLEL) {
          await Promise.all(
            due.slice(i, i + PARALLEL).map(async (delivery) => {
              const outcome = await this.send(
                delivery.webhookId,
                delivery.seq,
                delivery.at,
                delivery.event,
                delivery.attempts,
              );
              // Record the result only after the attempt, never before: this
              // ordering
              // is what makes delivery at-least-once.
              await this.deps.store.complete(delivery.id, outcome);
              this.deps.results?.inc({
                result: outcome.ok
                  ? 'delivered'
                  : outcome.retryAt
                    ? 'retry'
                    : 'dead',
              });
              if (!outcome.ok) {
                this.deps.logger.warn({
                  event: 'webhook.failed',
                  webhook: delivery.webhookId,
                  seq: delivery.seq,
                  status: outcome.status,
                  error: outcome.error,
                  retrying: Boolean(outcome.retryAt),
                });
              }
              sent += 1;
            }),
          );
        }
        if (this.stopped) {
          break;
        }
      }
      // Housekeeping at most once an hour.
      if (Date.now() > this.pruneAt) {
        this.pruneAt = Date.now() + 3_600_000;
        await this.deps.store.prune().catch(() => undefined);
      }
    } catch (error) {
      this.deps.logger.error({
        event: 'webhook.worker_error',
        error: error instanceof Error ? error.message : 'unknown',
      });
    } finally {
      this.running = false;
    }
    return sent;
  }

  // Make one attempt. Returns an Outcome; `retryAt` is set only for
  // failures worth retrying. A deleted or disabled webhook returns no
  // retryAt, so its delivery is given up on.
  private async send(
    webhookId: string,
    seq: number,
    at: string,
    event: CmsEvent,
    attempts: number,
  ): Promise<Outcome> {
    const webhook = this.deps.webhooks()[webhookId];
    if (!webhook) {
      return { ok: false, error: 'webhook was deleted' };
    }
    if (!webhook.active) {
      return { ok: false, error: 'webhook is switched off' };
    }
    // Back off progressively with the attempt count, capped at the last step.
    const backoff = this.deps.backoffSeconds ?? BACKOFF_SECONDS;
    const retryAt = new Date(
      Date.now() +
        (backoff[Math.min(attempts, backoff.length - 1)] as number) * 1000,
    );

    let secret: string;
    try {
      // Decrypt the signing secret just in time; it never sits in memory
      // longer.
      secret = this.deps.vault.decrypt(webhook.secret, `webhook:${webhook.id}`);
    } catch {
      return { ok: false, error: 'the signing secret could not be read' };
    }
    const url = new URL(webhook.url);
    let address: string;
    try {
      // SSRF defence, repeated on every attempt (DNS can change). `vet`
      // returns the checked IP, and the request connects to that exact IP.
      address = await this.deps.guard.vet(url.hostname.replace(/^\[|\]$/g, ''));
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message.slice(0, 120)
            : 'address not allowed',
        retryAt,
      };
    }

    const body = payloadFor(seq, at, event);
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const status = await post(url, address, body, {
        'Content-Type': 'application/json',
        'User-Agent': 'SethuCMS-Webhook/1',
        'X-Sethu-Event': event.type,
        'X-Sethu-Delivery': `evt_${seq}`,
        'X-Sethu-Signature': sign(secret, timestamp, body),
      });
      if (status >= 200 && status < 300) {
        return { ok: true, status };
      }
      return {
        ok: false,
        status,
        error: `the receiver answered ${status}`,
        retryAt,
      };
    } catch (error) {
      return {
        ok: false,
        // Short messages only: errors are stored and shown to admins.
        error: (error as Error).message.slice(0, 120),
        retryAt,
      };
    }
  }
}

// POST to a pre-vetted IP. `Host` and TLS `servername` still carry the
// real hostname so virtual hosts and certificate checks work. No redirect
// handling is used, so a 3xx cannot bounce us to an internal address.
function post(
  url: URL,
  address: string,
  body: string,
  headers: Record<string, string>,
): Promise<number> {
  const secure = url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          ...headers,
          Host: url.host,
          'Content-Length': Buffer.byteLength(body),
        },
        ...(secure ? { servername: url.hostname.replace(/^\[|\]$/g, '') } : {}),
        timeout: TIMEOUT_MS,
      },
      (response) => {
        // Only the status matters. Read a little so the connection can finish,
        // never keep it.
        let seen = 0;
        response.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > 1024) {
            response.destroy();
          }
        });
        response.on('end', () => resolve(response.statusCode ?? 0));
        response.on('close', () => resolve(response.statusCode ?? 0));
        response.on('error', () => resolve(response.statusCode ?? 0));
      },
    );
    request.on('timeout', () =>
      request.destroy(new Error('timed out after 10 seconds')),
    );
    request.on('error', (error) =>
      reject(
        new Error(
          error.message.startsWith('timed out')
            ? error.message
            : 'could not connect to the receiver',
        ),
      ),
    );
    request.end(body);
  });
}
