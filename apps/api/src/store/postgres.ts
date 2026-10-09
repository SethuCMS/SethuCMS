/**
 * Shared state for several gateways, kept in one PostgreSQL database.
 *
 * What is shared:
 *   - the gateway's own state (connections, drafts, tokens, migration history)
 *   - the audit log (one hash chain per gateway process, all in one table)
 *   - Idempotency-Key answers (a retry may reach a different gateway)
 *   - live events (relayed with LISTEN / NOTIFY)
 *
 * What is NOT shared (each gateway keeps its own):
 *   - rate-limit counters, so the real limit is "per gateway" (N gateways allow
 * about N times the limit)
 *   - open database connections to the customer's databases
 *
 * State is one JSON document in one row. A change locks the row, applies the
 * change to the latest copy, writes it and bumps a version number, so two
 * gateways can never overwrite each other. Other gateways pick the change up
 * from a NOTIFY (normally within milliseconds) or from the poll (default 1 s),
 * so a revoked token can still work on another gateway for up to the poll time.
 */
import { randomBytes } from 'node:crypto';
import { emptyState, type State, type StateStore } from './state.js';

/** The small part of the `pg` driver this file uses. */
/** Minimal shape of a `pg` client, so `pg` stays an optional dependency. */
interface PgClient {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
  release?(error?: unknown): void;
  connect?(): Promise<void>;
  end?(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
}
/** Minimal shape of a `pg` pool. */
interface PgPool {
  query: PgClient['query'];
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
/** Minimal shape of the dynamically imported `pg` module. */
interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
  Client: new (config: Record<string, unknown>) => PgClient;
}

/** Settings for opening {@link SharedDb}. */
export interface SharedDbOptions {
  /** PostgreSQL connection string. */
  url: string;
  /**
   * Unique per gateway process. Used to tell our own NOTIFYs from other
   * gateways'.
   */
  instanceId?: string;
  /** Maximum pooled connections (default 10). */
  poolSize?: number;
}

/** Receives the raw text payload of a NOTIFY. */
type NotifyHandler = (payload: string) => void;

/** NOTIFY channel announcing state changes. */
const STATE_CHANNEL = 'sethucms_state';
/** NOTIFY channel carrying live CMS events between gateways. */
export const EVENT_CHANNEL = 'sethucms_events';
/** NOTIFY channel announcing new webhook outbox rows. */
export const OUTBOX_CHANNEL = 'sethucms_outbox';

/** Idempotent DDL, safe to run on every start. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sethucms_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  version bigint NOT NULL,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sethucms_audit (
  seq bigserial PRIMARY KEY,
  chain text NOT NULL,
  entry jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS sethucms_audit_chain ON sethucms_audit (chain, seq);
CREATE TABLE IF NOT EXISTS sethucms_idempotency (
  key text PRIMARY KEY,
  fingerprint text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  status integer,
  body jsonb,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS sethucms_outbox (
  seq bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  event jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS sethucms_deliveries (
  id bigserial PRIMARY KEY,
  outbox_seq bigint NOT NULL,
  webhook_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  next_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text,
  last_status integer,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_seq, webhook_id)
);
CREATE INDEX IF NOT EXISTS sethucms_deliveries_due ON sethucms_deliveries (status, next_at);
`;

/**
 * One connection pool plus one listening connection, shared by everything in a
 * gateway process.
 */
export class SharedDb {
  readonly instanceId: string;
  private pool!: PgPool;
  private listener: PgClient | undefined;
  private readonly handlers = new Map<string, Set<NotifyHandler>>();
  private reconnect: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly onReconnect = new Set<() => void>();

  private constructor(private readonly options: SharedDbOptions) {
    this.instanceId =
      options.instanceId ?? `gw_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Connect, create tables if needed and start listening for NOTIFYs.
   * @throws Error when the optional `pg` package is not installed.
   */
  static async open(options: SharedDbOptions): Promise<SharedDb> {
    const db = new SharedDb(options);
    // Loaded by name so the driver is only needed when sharing state.
    const driver = 'pg';
    let mod: PgModule;
    try {
      const imported = (await import(driver)) as {
        default?: PgModule;
      } & Partial<PgModule>;
      mod = (imported.default ?? imported) as PgModule;
    } catch {
      throw new Error(
        'SETHUCMS_STATE_URL needs the "pg" package. Install it with: pnpm add pg (in apps/api)',
      );
    }
    db.pg = mod;
    db.pool = new mod.Pool({
      connectionString: options.url,
      max: options.poolSize ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // An idle pooled connection can be dropped by the server; that must not
    // crash the gateway.
    db.pool.on('error', () => undefined);
    await db.initSchema();
    await db.startListening();
    return db;
  }

  // Set in open(); the driver is imported lazily.
  private pg!: PgModule;

  /** Run one statement on any pooled connection. */
  query(text: string, values?: unknown[]) {
    return this.pool.query(text, values);
  }

  /** Run `work` in a transaction on one connection. */
  async transaction<T>(work: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }

  /**
   * Send a NOTIFY. Best effort: failures are swallowed, since peers also
   * catch up by polling.
   */
  async notify(channel: string, payload: unknown): Promise<void> {
    await this.pool
      .query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)])
      .catch(() => undefined);
  }

  /**
   * Call `handler` with the text of every NOTIFY on `channel`. Returns a
   * function that stops listening.
   */
  listen(channel: string, handler: NotifyHandler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      this.handlers.set(channel, (set = new Set()));
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Called after the listening connection came back, because notifications may
   * have been missed meanwhile.
   */
  afterReconnect(callback: () => void): void {
    this.onReconnect.add(callback);
  }

  /** Stop reconnecting and close the listener and pool. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnect) {
      clearTimeout(this.reconnect);
    }
    const listener = this.listener;
    this.listener = undefined;
    await listener?.end?.().catch(() => undefined);
    await this.pool.end().catch(() => undefined);
  }

  private async initSchema(): Promise<void> {
    // An advisory lock makes gateways that start at the same moment create the
    // tables one at a time.
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(727001)');
      await client.query(SCHEMA);
      await client.query(
        `INSERT INTO sethucms_state (id, version, data) VALUES (1, 0, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(emptyState())],
      );
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(727001)')
        .catch(() => undefined);
      client.release?.();
    }
  }

  // LISTEN needs its own long-lived connection; pooled ones get recycled.
  private async startListening(): Promise<void> {
    if (this.closed) {
      return;
    }
    const client = new this.pg.Client({ connectionString: this.options.url });
    client.on('error', () => this.scheduleReconnect(client));
    client.on('end', () => this.scheduleReconnect(client));
    client.on(
      'notification',
      (message: { channel: string; payload?: string }) => {
        for (const handler of this.handlers.get(message.channel) ?? []) {
          try {
            handler(message.payload ?? '');
          } catch {
            // One broken listener must not stop the others.
          }
        }
      },
    );
    await client.connect!();
    for (const channel of [STATE_CHANNEL, EVENT_CHANNEL, OUTBOX_CHANNEL]) {
      await client.query(`LISTEN ${channel}`);
    }
    this.listener = client;
  }

  /**
   * Replace a dead listener after a short delay, then tell subscribers to
   * re-sync, since NOTIFYs sent during the gap are lost.
   */
  private scheduleReconnect(from: PgClient): void {
    if (this.closed || this.listener !== from || this.reconnect) {
      return;
    }
    this.listener = undefined;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      this.startListening().then(
        () => {
          for (const callback of this.onReconnect) {
            callback();
          }
        },
        () => this.scheduleReconnect(undefined as unknown as PgClient),
      );
    }, 1000);
    this.reconnect.unref();
  }
}

/** Gateway state in PostgreSQL. See the notes at the top of this file. */
export class PostgresStateStore implements StateStore {
  private state: State = emptyState();
  private version = -1;
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> | undefined;

  private constructor(private readonly db: SharedDb) {}

  static async open(
    db: SharedDb,
    options: { pollMs?: number } = {},
  ): Promise<PostgresStateStore> {
    const store = new PostgresStateStore(db);
    await store.refresh();
    db.listen(STATE_CHANNEL, (payload) => {
      try {
        const { o } = JSON.parse(payload) as { o?: string };
        if (o === db.instanceId) {
          return;
        } // our own change is already applied
      } catch {
        // an unreadable payload still means "something changed": refresh
      }
      void store.refresh();
    });
    db.afterReconnect(() => void store.refresh());
    const pollMs = options.pollMs ?? 1000;
    store.timer = setInterval(() => void store.refresh(), pollMs);
    store.timer.unref();
    return store;
  }

  // Served from memory; never touches the database.
  read(): State {
    return this.state;
  }

  /**
   * Apply `change` to the latest shared state and save it.
   * @returns Whatever `change` returns.
   */
  async update<T>(change: (state: State) => T): Promise<T> {
    const { result, next, version } = await this.db.transaction(
      async (client) => {
        const row = (
          await client.query(
            // FOR UPDATE locks the row so concurrent gateways apply changes one
            // after another to the newest copy (no lost updates).
            'SELECT version, data FROM sethucms_state WHERE id = 1 FOR UPDATE',
          )
        ).rows[0] as { version: string; data: State };
        // Defaults are merged in so state written by an older version still has
        // every field.
        const draft: State = { ...emptyState(), ...structuredClone(row.data) };
        const result = change(draft);
        const version = Number(row.version) + 1;
        await client.query(
          'UPDATE sethucms_state SET version = $1, data = $2::jsonb WHERE id = 1',
          [version, JSON.stringify(draft)],
        );
        return { result, next: draft, version };
      },
    );
    // Visible to this gateway at once; other gateways learn from the NOTIFY.
    if (version > this.version) {
      this.state = next;
      this.version = version;
    }
    await this.db.notify(STATE_CHANNEL, { o: this.db.instanceId, v: version });
    return result;
  }

  /** Stop the polling timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  /** Load the newest copy when another gateway changed it. */
  private refresh(): Promise<void> {
    // Share one in-flight refresh among callers instead of stacking queries.
    this.refreshing ??= (async () => {
      try {
        const head = (
          await this.db.query('SELECT version FROM sethucms_state WHERE id = 1')
        ).rows[0] as { version: string } | undefined;
        if (!head || Number(head.version) <= this.version) {
          return;
        }
        const row = (
          await this.db.query(
            'SELECT version, data FROM sethucms_state WHERE id = 1',
          )
        ).rows[0] as { version: string; data: State };
        if (Number(row.version) > this.version) {
          this.state = { ...emptyState(), ...row.data };
          this.version = Number(row.version);
        }
      } catch {
        // The database is unreachable for a moment: keep serving the copy we
        // have.
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
}
