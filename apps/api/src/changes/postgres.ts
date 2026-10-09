/**
 * The change feed and delivery queue in PostgreSQL, for several gateways (and
 * separate workers) sharing one queue.
 */
import type { CmsEvent } from '../events.js';
import { OUTBOX_CHANNEL, type SharedDb } from '../store/postgres.js';
import {
  MAX_ATTEMPTS,
  type ChangeRecord,
  type ChangeStore,
  type Delivery,
  type DeliveryStatus,
  type Outcome,
} from './store.js';

// Retention: newest events and recent finished deliveries are kept.
const KEEP_EVENTS = 10_000;
const KEEP_FINISHED_DAYS = 14;

// Map a database row to the public delivery shape (numeric ids arrive
// as strings from the driver).
const toDelivery = (row: any): Delivery => ({
  id: Number(row.id),
  seq: Number(row.outbox_seq),
  webhookId: row.webhook_id,
  attempts: row.attempts,
  status: row.status,
  nextAt: new Date(row.next_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  ...(row.last_error ? { lastError: row.last_error } : {}),
  ...(row.last_status ? { lastStatus: row.last_status } : {}),
});

/**
 * Shared change feed and delivery queue in PostgreSQL.
 *
 * Several gateways and workers can use one database safely: each
 * delivery is leased to exactly one worker at a time.
 */
export class PostgresChangeStore implements ChangeStore {
  constructor(private readonly db: SharedDb) {}

  // Event and its delivery rows are inserted in one transaction, so a
  // change is never recorded without its deliveries (or vice versa).
  // ON CONFLICT DO NOTHING keeps a retried insert harmless.
  async append(event: CmsEvent, webhookIds: string[]): Promise<number> {
    const seq = await this.db.transaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO sethucms_outbox (event) VALUES ($1::jsonb) RETURNING seq',
        [JSON.stringify(event)],
      );
      const seq = Number((rows[0] as { seq: string }).seq);
      for (const webhookId of webhookIds) {
        await client.query(
          'INSERT INTO sethucms_deliveries (outbox_seq, webhook_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [seq, webhookId],
        );
      }
      return seq;
    });
    // After commit, wake workers (including other processes) via NOTIFY.
    if (webhookIds.length > 0) {
      await this.db.notify(OUTBOX_CHANNEL, { o: this.db.instanceId });
    }
    return seq;
  }

  async since(seq: number, limit: number): Promise<ChangeRecord[]> {
    const { rows } = await this.db.query(
      'SELECT seq, at, event FROM sethucms_outbox WHERE seq > $1 ORDER BY seq LIMIT $2',
      [seq, limit],
    );
    return rows.map((row: any) => ({
      seq: Number(row.seq),
      at: new Date(row.at).toISOString(),
      event: row.event as CmsEvent,
    }));
  }

  async head(): Promise<number> {
    const { rows } = await this.db.query(
      'SELECT COALESCE(MAX(seq), 0) AS head FROM sethucms_outbox',
    );
    return Number((rows[0] as { head: string }).head);
  }

  async oldest(): Promise<number> {
    const { rows } = await this.db.query(
      'SELECT COALESCE(MIN(seq), 0) AS oldest FROM sethucms_outbox',
    );
    return Number((rows[0] as { oldest: string }).oldest);
  }

  async claim(
    limit: number,
    leaseMs: number,
  ): Promise<Array<Delivery & { event: CmsEvent; at: string }>> {
    // SKIP LOCKED lets several workers take different deliveries at the same
    // time without waiting for each other.
    const { rows } = await this.db.query(
      `WITH due AS (
         SELECT id FROM sethucms_deliveries
         WHERE status = 'pending' AND next_at <= now() AND (locked_until IS NULL OR locked_until < now())
         ORDER BY next_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
       )
       UPDATE sethucms_deliveries d SET locked_until = now() + make_interval(secs => $2)
       FROM due WHERE d.id = due.id
       RETURNING d.*, (SELECT event FROM sethucms_outbox o WHERE o.seq = d.outbox_seq) AS event,
                      (SELECT at FROM sethucms_outbox o WHERE o.seq = d.outbox_seq) AS event_at`,
      [limit, leaseMs / 1000],
    );
    const out: Array<Delivery & { event: CmsEvent; at: string }> = [];
    for (const row of rows as any[]) {
      // The event was pruned before delivery; give up on it instead of
      // retrying.
      if (!row.event) {
        await this.db.query(
          `UPDATE sethucms_deliveries SET status = 'dead', last_error = 'event no longer available', locked_until = NULL, updated_at = now() WHERE id = $1`,
          [row.id],
        );
        continue;
      }
      out.push({
        ...toDelivery(row),
        event: row.event as CmsEvent,
        at: new Date(row.event_at).toISOString(),
      });
    }
    return out;
  }

  // `attempts + 1 >= MAX_ATTEMPTS` is checked in SQL so concurrent updates
  // cannot push a delivery past its limit.
  async complete(id: number, outcome: Outcome): Promise<void> {
    const error = outcome.error ? outcome.error.slice(0, 200) : null;
    if (outcome.ok) {
      await this.db.query(
        `UPDATE sethucms_deliveries SET status = 'delivered', attempts = attempts + 1, last_error = NULL, last_status = $2, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [id, outcome.status ?? null],
      );
    } else if (outcome.retryAt) {
      await this.db.query(
        `UPDATE sethucms_deliveries SET attempts = attempts + 1, last_error = $2, last_status = $3, locked_until = NULL, updated_at = now(),
           status = CASE WHEN attempts + 1 >= $5 THEN 'dead' ELSE 'pending' END, next_at = $4 WHERE id = $1`,
        [
          id,
          error,
          outcome.status ?? null,
          outcome.retryAt.toISOString(),
          MAX_ATTEMPTS,
        ],
      );
    } else {
      await this.db.query(
        `UPDATE sethucms_deliveries SET status = 'dead', attempts = attempts + 1, last_error = $2, last_status = $3, locked_until = NULL, updated_at = now() WHERE id = $1`,
        [id, error, outcome.status ?? null],
      );
    }
  }

  async deliveries(webhookId: string, limit: number): Promise<Delivery[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sethucms_deliveries WHERE webhook_id = $1 ORDER BY id DESC LIMIT $2',
      [webhookId, limit],
    );
    return rows.map(toDelivery);
  }

  async counts(): Promise<Record<DeliveryStatus, number>> {
    const { rows } = await this.db.query(
      'SELECT status, count(*)::int AS n FROM sethucms_deliveries GROUP BY status',
    );
    const counts: Record<DeliveryStatus, number> = {
      pending: 0,
      delivered: 0,
      dead: 0,
    };
    for (const row of rows as Array<{ status: DeliveryStatus; n: number }>) {
      counts[row.status] = row.n;
    }
    return counts;
  }

  async prune(): Promise<void> {
    await this.db.query(
      `DELETE FROM sethucms_deliveries WHERE status <> 'pending' AND updated_at < now() - make_interval(days => $1)`,
      [KEEP_FINISHED_DAYS],
    );
    // Keep the newest events, and any event a pending delivery still needs.
    await this.db.query(
      `DELETE FROM sethucms_outbox WHERE seq < (SELECT COALESCE(MAX(seq), 0) FROM sethucms_outbox) - $1
         AND seq NOT IN (SELECT outbox_seq FROM sethucms_deliveries WHERE status = 'pending')`,
      [KEEP_EVENTS],
    );
  }

  async close(): Promise<void> {}
}
