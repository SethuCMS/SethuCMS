/**
 * The change feed and the delivery queue.
 *
 * Every change made through the gateway is appended here with a growing
 * sequence number, so a consumer can ask "what happened after number N?" and
 * never miss or repeat anything. Webhook deliveries are queued here as well.
 *
 * Events carry ids only, never field values (see events.ts).
 *
 * Three implementations: in memory, in a file (single gateway, survives a
 * restart), and in PostgreSQL (several gateways, see changes/postgres.ts).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CmsEvent } from '../events.js';

/** One entry of the change feed: a sequence number, time and the event. */
export interface ChangeRecord {
  seq: number;
  at: string;
  event: CmsEvent;
}

/**
 * `pending` = still to try, `delivered` = receiver accepted, `dead` = gave up.
 */
export type DeliveryStatus = 'pending' | 'delivered' | 'dead';

/** One webhook's delivery attempt state for one change. */
export interface Delivery {
  id: number;
  seq: number;
  webhookId: string;
  attempts: number;
  status: DeliveryStatus;
  nextAt: string;
  lastError?: string;
  lastStatus?: number;
  updatedAt: string;
}

/** What happened on one delivery attempt, reported back to the store. */
export interface Outcome {
  ok: boolean;
  /** HTTP status the receiver answered with, if any. */
  status?: number;
  /** Short reason, never a response body. */
  error?: string;
  /** When to try again. Omit to give up (the delivery becomes "dead"). */
  retryAt?: Date;
}

/**
 * Storage contract shared by the memory, file and PostgreSQL stores.
 *
 * Delivery is at-least-once: a claimed delivery whose worker dies is
 * handed out again once its lease expires, so receivers may see an event
 * more than once and should de-duplicate on the sequence number.
 */
export interface ChangeStore {
  /**
   * Add an event and queue a delivery for each webhook. Returns its sequence
   * number.
   */
  append(event: CmsEvent, webhookIds: string[]): Promise<number>;
  /** Events after `seq`, oldest first. */
  since(seq: number, limit: number): Promise<ChangeRecord[]>;
  /** The newest sequence number, 0 when empty. */
  head(): Promise<number>;
  /**
   * The oldest sequence number still kept (older ones were pruned), 0 when
   * empty.
   */
  oldest(): Promise<number>;
  /**
   * Take up to `limit` deliveries that are due, and keep them for `leaseMs` so
   * no other worker takes them.
   */
  claim(
    limit: number,
    leaseMs: number,
  ): Promise<Array<Delivery & { event: CmsEvent; at: string }>>;
  complete(id: number, outcome: Outcome): Promise<void>;
  /** Newest first. */
  deliveries(webhookId: string, limit: number): Promise<Delivery[]>;
  /** Counts of deliveries by status, for metrics. */
  counts(): Promise<Record<DeliveryStatus, number>>;
  /** Forget old events and finished deliveries. */
  prune(): Promise<void>;
  close(): Promise<void>;
}

/** Attempts before a delivery is marked dead. */
export const MAX_ATTEMPTS = 8;
/** Seconds to wait after attempt 1, 2, 3 ... Gives up after MAX_ATTEMPTS. */
export const BACKOFF_SECONDS = [10, 30, 120, 600, 1800, 3600, 10_800];

// Retention: old events are pruned; unfinished deliveries are kept.
const KEEP_EVENTS = 10_000;
const KEEP_FINISHED = 2_000;

/**
 * In-memory store. Fine for tests and single-process runs, but state is
 * lost on restart unless `FileChangeStore` persists it.
 */
export class MemoryChangeStore implements ChangeStore {
  protected seq = 0;
  protected events: ChangeRecord[] = [];
  protected queue: Delivery[] = [];
  protected nextDelivery = 1;
  // Delivery id -> lease expiry. Kept in memory only, so a restart makes
  // everything claimable again (at-least-once).
  private readonly leases = new Map<number, number>();
  // Set on every change so the file store knows a flush is needed.
  protected dirty = false;

  async append(event: CmsEvent, webhookIds: string[]): Promise<number> {
    const now = new Date().toISOString();
    this.seq += 1;
    this.events.push({ seq: this.seq, at: now, event });
    for (const webhookId of webhookIds) {
      this.queue.push({
        id: this.nextDelivery++,
        seq: this.seq,
        webhookId,
        attempts: 0,
        status: 'pending',
        nextAt: now,
        updatedAt: now,
      });
    }
    // Prune in batches (20% slack) rather than on every append.
    if (this.events.length > KEEP_EVENTS * 1.2) {
      await this.prune();
    }
    this.dirty = true;
    return this.seq;
  }

  async since(seq: number, limit: number): Promise<ChangeRecord[]> {
    const start = this.events.findIndex((record) => record.seq > seq);
    return start < 0 ? [] : this.events.slice(start, start + limit);
  }

  async head(): Promise<number> {
    return this.seq;
  }

  async oldest(): Promise<number> {
    return this.events[0]?.seq ?? 0;
  }

  async claim(
    limit: number,
    leaseMs: number,
  ): Promise<Array<Delivery & { event: CmsEvent; at: string }>> {
    const now = Date.now();
    const out: Array<Delivery & { event: CmsEvent; at: string }> = [];
    for (const delivery of this.queue) {
      if (out.length >= limit) {
        break;
      }
      if (
        delivery.status !== 'pending' ||
        Date.parse(delivery.nextAt) > now ||
        (this.leases.get(delivery.id) ?? 0) > now
      ) {
        continue;
      }
      const record = this.events.find((item) => item.seq === delivery.seq);
      if (!record) {
        // The event was pruned before it could be delivered.
        delivery.status = 'dead';
        delivery.lastError = 'event no longer available';
        continue;
      }
      // Lease, not removal: if the worker crashes the delivery becomes
      // due again after `leaseMs`.
      this.leases.set(delivery.id, now + leaseMs);
      out.push({ ...delivery, event: record.event, at: record.at });
    }
    return out;
  }

  async complete(id: number, outcome: Outcome): Promise<void> {
    const delivery = this.queue.find((item) => item.id === id);
    if (!delivery) {
      return;
    }
    this.leases.delete(id);
    delivery.attempts += 1;
    delivery.updatedAt = new Date().toISOString();
    if (outcome.error) {
      // Truncate: error text comes from the network and must stay small.
      delivery.lastError = outcome.error.slice(0, 200);
    }
    if (outcome.status !== undefined) {
      delivery.lastStatus = outcome.status;
    }
    if (outcome.ok) {
      delivery.status = 'delivered';
      delete delivery.lastError;
    } else if (outcome.retryAt && delivery.attempts < MAX_ATTEMPTS) {
      delivery.nextAt = outcome.retryAt.toISOString();
    } else {
      delivery.status = 'dead';
    }
    this.dirty = true;
  }

  async deliveries(webhookId: string, limit: number): Promise<Delivery[]> {
    return this.queue
      .filter((item) => item.webhookId === webhookId)
      .slice(-limit)
      .reverse()
      .map((item) => ({ ...item }));
  }

  async counts(): Promise<Record<DeliveryStatus, number>> {
    const counts: Record<DeliveryStatus, number> = {
      pending: 0,
      delivered: 0,
      dead: 0,
    };
    for (const item of this.queue) {
      counts[item.status] += 1;
    }
    return counts;
  }

  async prune(): Promise<void> {
    if (this.events.length > KEEP_EVENTS) {
      this.events = this.events.slice(-KEEP_EVENTS);
    }
    const pending = this.queue.filter((item) => item.status === 'pending');
    const finished = this.queue
      .filter((item) => item.status !== 'pending')
      .slice(-KEEP_FINISHED);
    this.queue = [...finished, ...pending].sort((a, b) => a.id - b.id);
    this.dirty = true;
  }

  async close(): Promise<void> {}
}

// Shape of changes.json.
interface Snapshot {
  seq: number;
  events: ChangeRecord[];
  queue: Delivery[];
  nextDelivery: number;
}

/**
 * Memory plus a snapshot file in the data folder, written a moment after each
 * change (at most once a second). A crash can lose the last second of changes;
 * for a guarantee use PostgreSQL.
 */
export class FileChangeStore extends MemoryChangeStore {
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();

  private constructor(private readonly path: string) {
    super();
  }

  /**
   * Open (or create) the store in `dataDir`, loading a saved snapshot.
   * The folder is created private (0700) since events name internal ids.
   *
   * @returns The store, with a once-a-second background flush running.
   */
  static async open(dataDir: string): Promise<FileChangeStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = new FileChangeStore(join(dataDir, 'changes.json'));
    try {
      const saved = JSON.parse(await readFile(store.path, 'utf8')) as Snapshot;
      store.seq = saved.seq;
      store.events = saved.events;
      store.queue = saved.queue;
      store.nextDelivery = saved.nextDelivery;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A damaged snapshot must not stop the gateway; the feed simply
        // restarts.
        process.stderr.write(
          'changes.json could not be read; starting an empty change feed\n',
        );
      }
    }
    store.timer = setInterval(() => void store.flush(), 1000);
    store.timer.unref();
    return store;
  }

  /** Write the snapshot now if anything changed. Writes are serialised. */
  async flush(): Promise<void> {
    this.writing = this.writing
      .then(async () => {
        if (!this.dirty) {
          return;
        }
        this.dirty = false;
        const snapshot: Snapshot = {
          seq: this.seq,
          events: this.events,
          queue: this.queue,
          nextDelivery: this.nextDelivery,
        };
        // Write to a temp file then rename: the rename is atomic, so a crash
        // never leaves a half-written changes.json. Mode 0600: owner-only.
        const temporary = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
        await rename(temporary, this.path);
      })
      .catch(() => undefined);
    await this.writing;
  }

  // Final flush so a clean shutdown loses nothing.
  override async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.dirty = true;
    await this.flush();
  }
}
