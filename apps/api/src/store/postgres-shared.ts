/**
 * The other shared pieces for several gateways: audit sink, Idempotency-Key
 * answers and the live-event relay. See postgres.ts for what is and is not
 * shared.
 */
import { createHash } from 'node:crypto';
import { errors } from '@sethucms/core';
import type { AuditEntry, AuditSink } from '../audit.js';
import type { CmsEvent, EventBus } from '../events.js';
import type { SavedResponse } from '../security/idempotency.js';
import { EVENT_CHANNEL, type SharedDb } from './postgres.js';

/**
 * Audit log stored in the shared database. Each gateway process writes its
 * own hash chain (see audit.ts), so chains can be verified independently.
 */
export class PostgresAuditSink implements AuditSink {
  /** Chain id; equals this gateway's instance id. */
  readonly chain: string;

  constructor(private readonly db: SharedDb) {
    // One chain per gateway process: entries from different gateways never
    // share a chain.
    this.chain = db.instanceId;
  }

  /** Add one entry to this gateway's chain. */
  async append(entry: AuditEntry): Promise<void> {
    await this.db.query(
      'INSERT INTO sethucms_audit (chain, entry) VALUES ($1, $2::jsonb)',
      [this.chain, JSON.stringify(entry)],
    );
  }

  /**
   * Newest entries across all chains, newest first.
   * @param limit Maximum number of entries to return.
   */
  async latest(limit: number): Promise<AuditEntry[]> {
    const { rows } = await this.db.query(
      'SELECT entry FROM sethucms_audit ORDER BY seq DESC LIMIT $1',
      [limit],
    );
    return rows.map((row: { entry: AuditEntry }) => row.entry);
  }

  /** Yield each chain's entries in order, for integrity verification. */
  async *chains(): AsyncGenerator<{ chain: string; entries: AuditEntry[] }> {
    const { rows: names } = await this.db.query(
      'SELECT DISTINCT chain FROM sethucms_audit ORDER BY chain',
    );
    for (const { chain } of names as Array<{ chain: string }>) {
      // Read in pages so a long log does not have to fit in memory at once.
      let after = 0;
      const entries: AuditEntry[] = [];
      for (;;) {
        const { rows } = await this.db.query(
          'SELECT seq, entry FROM sethucms_audit WHERE chain = $1 AND seq > $2 ORDER BY seq LIMIT 5000',
          [chain, after],
        );
        if (rows.length === 0) {
          break;
        }
        for (const row of rows as Array<{ seq: string; entry: AuditEntry }>) {
          entries.push(row.entry);
        }
        after = Number((rows[rows.length - 1] as { seq: string }).seq);
      }
      yield { chain, entries };
    }
  }
}

/** Same key limits as the in-memory store in security/idempotency.ts. */
const MAX_KEY_LENGTH = 128;
const TTL_HOURS = 24;
/** How long a duplicate request waits for the first one to finish. */
const WAIT_MS = 10_000;

/**
 * Idempotency-Key answers in the shared database, so a retry that reaches
 * another gateway still gets the saved answer.
 */
export class PostgresIdempotencyStore {
  constructor(private readonly db: SharedDb) {}

  /**
   * Run `work` once per (caller, key) across all gateways; replay later.
   * Same contract as IdempotencyStore.run in security/idempotency.ts.
   *
   * @throws ValidationError for a malformed key; ConflictError for key reuse
   * with a different request, or when the first request is still running
   * after the wait limit.
   */
  async run(
    caller: string,
    key: string,
    operation: string,
    body: unknown,
    work: () => Promise<SavedResponse>,
  ): Promise<SavedResponse> {
    if (
      key.length === 0 ||
      key.length > MAX_KEY_LENGTH ||
      !/^[\x21-\x7e]+$/.test(key)
    ) {
      throw errors.validation(
        'Idempotency-Key must be 1 to 128 printable characters',
      );
    }
    // Occasional cleanup instead of a timer: cheap, and any gateway can do it.
    if (Math.random() < 0.01) {
      void this.db
        .query('DELETE FROM sethucms_idempotency WHERE expires_at < now()')
        .catch(() => undefined);
    }

    const id = `${caller}:${key}`;
    const fingerprint = createHash('sha256')
      .update(operation)
      .update('\0')
      .update(JSON.stringify(body ?? null))
      .digest('hex');

    // The INSERT is the lock: the database decides atomically which gateway
    // wins, so only one runs `work`.
    // Claim the key. An expired entry is taken over; a live one is left alone.
    const claim = await this.db.query(
      `INSERT INTO sethucms_idempotency (key, fingerprint, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))
       ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, done = false, status = NULL, body = NULL, expires_at = EXCLUDED.expires_at
       WHERE sethucms_idempotency.expires_at < now() RETURNING key`,
      [id, fingerprint, TTL_HOURS],
    );
    if ((claim.rowCount ?? 0) === 1) {
      try {
        const saved = await work();
        // Keep successful and client-error answers; let server errors be
        // retried for real.
        if (saved.status >= 500) {
          await this.forget(id);
        } else {
          await this.db.query(
            'UPDATE sethucms_idempotency SET done = true, status = $2, body = $3::jsonb WHERE key = $1',
            [id, saved.status, JSON.stringify(saved.body ?? null)],
          );
        }
        return saved;
      } catch (error) {
        await this.forget(id);
        throw error;
      }
    }

    // The loser polls rather than failing, so a retry during a slow write
    // still gets the real answer.
    // Someone else holds it: replay their answer, or wait while they are still
    // working.
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const { rows } = await this.db.query(
        'SELECT fingerprint, done, status, body FROM sethucms_idempotency WHERE key = $1',
        [id],
      );
      const row = rows[0] as
        | {
            fingerprint: string;
            done: boolean;
            status: number | null;
            body: unknown;
          }
        | undefined;
      if (!row) {
        return this.run(caller, key, operation, body, work);
      } // it was forgotten (a server error): try again
      if (row.fingerprint !== fingerprint) {
        throw errors.conflict(
          'This Idempotency-Key was already used for a different request',
        );
      }
      if (row.done) {
        return { status: row.status ?? 200, body: row.body ?? undefined };
      }
      if (Date.now() > deadline) {
        throw errors.conflict(
          'A request with this Idempotency-Key is still being processed. Try again shortly',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Delete the key so the client can retry; errors are ignored. */
  private async forget(id: string): Promise<void> {
    await this.db
      .query('DELETE FROM sethucms_idempotency WHERE key = $1', [id])
      .catch(() => undefined);
  }
}

/**
 * Send local events to the other gateways, and deliver theirs to local
 * listeners.
 */
/**
 * Connect the local EventBus to other gateways via LISTEN/NOTIFY.
 *
 * @param db Shared database.
 * @param events Local bus whose events are forwarded out.
 * @param onRemote Called with each event received from another gateway.
 * @returns A function that stops the relay.
 */
export function relayEvents(
  db: SharedDb,
  events: EventBus,
  onRemote?: (event: CmsEvent) => void,
): () => void {
  events.setRelay(
    (event) => void db.notify(EVENT_CHANNEL, { o: db.instanceId, e: event }),
  );
  const stop = db.listen(EVENT_CHANNEL, (payload) => {
    try {
      const message = JSON.parse(payload) as { o?: string; e?: CmsEvent };
      // Skip our own echo: local listeners already got this event directly.
      if (!message.e || message.o === db.instanceId) {
        return;
      }
      onRemote?.(message.e);
      events.publishRemote(message.e);
    } catch {
      // ignore anything that is not an event
    }
  });
  return () => {
    stop();
    events.setRelay(undefined);
  };
}
