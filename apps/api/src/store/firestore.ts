/**
 * The gateway's own data in Google Cloud Firestore (Firebase), so one gateway
 * can run with no disk and no PostgreSQL: saved connections, drafts, API
 * tokens, webhooks, migration history, the audit log and the change feed.
 *
 * This is NOT the customer's data. Customer records stay in their databases.
 *
 * One gateway at a time. A short lease document in Firestore keeps a second
 * gateway from starting on the same state (the same job the data-folder lock
 * does on disk). Running several gateways on shared state needs PostgreSQL
 * (see postgres.ts).
 *
 * Design choices, each to keep this simple and safe:
 *  - Every record is stored as one JSON string field. Firestore refuses some
 *    key names and `undefined` values, and the gateway's records are
 *    open-ended, so a string avoids surprises. Secrets inside records are
 *    already encrypted by the vault before they get here.
 *  - Only documents that changed are written, in batches, before the
 *    in-memory copy is replaced. A failed write leaves memory unchanged.
 *  - No composite indexes are needed: every query orders by document id.
 *  - The client is described by a small structural interface, so tests run
 *    against an in-memory fake and the real driver is loaded only when used.
 */
import { randomBytes } from 'node:crypto';
import type { AuditEntry, AuditSink } from '../audit.js';
import { MemoryChangeStore } from '../changes/store.js';
import type { ChangeRecord, Delivery } from '../changes/store.js';
import { emptyState, MemoryStateStore, type State } from './state.js';

// ---------------------------------------------------------------------------
// The part of the Firestore API this file uses. The real driver matches it.

export interface FsSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): any;
}
export interface FsQuerySnapshot {
  readonly docs: FsSnapshot[];
}
export interface FsDocRef {
  readonly id: string;
  get(): Promise<FsSnapshot>;
  set(data: any): Promise<unknown>;
  delete(): Promise<unknown>;
}
export interface FsQuery {
  orderBy(field: string, direction?: 'asc' | 'desc'): FsQuery;
  limit(count: number): FsQuery;
  startAfter(snapshot: FsSnapshot): FsQuery;
  get(): Promise<FsQuerySnapshot>;
}
export interface FsCollection extends FsQuery {
  doc(id: string): FsDocRef;
}
export interface FsBatch {
  set(ref: FsDocRef, data: any): FsBatch;
  delete(ref: FsDocRef): FsBatch;
  commit(): Promise<unknown>;
}
export interface FsTransaction {
  get(ref: FsDocRef): Promise<FsSnapshot>;
  set(ref: FsDocRef, data: any): FsTransaction;
  delete(ref: FsDocRef): FsTransaction;
}
export interface FirestoreLike {
  collection(name: string): FsCollection;
  batch(): FsBatch;
  runTransaction<T>(work: (tx: FsTransaction) => Promise<T>): Promise<T>;
  terminate?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Settings and the real driver

export interface FirestoreSettings {
  /** Google Cloud / Firebase project id. */
  projectId: string;
  /** Prefix for the collection names. Default "sethucms". */
  prefix?: string;
  /**
   * A service-account key as JSON text, for hosts with no Google identity of
   * their own (Fly.io, a VPS). Omit on Google Cloud, where the platform
   * identity or GOOGLE_APPLICATION_CREDENTIALS is used.
   */
  credentialsJson?: string;
  /** host:port of the local Firestore emulator (development only). */
  emulatorHost?: string;
}

/** The collection-name prefix, validated. */
export function firestorePrefix(settings: { prefix?: string }): string {
  const prefix = settings.prefix ?? 'sethucms';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(prefix)) {
    throw new Error(
      'SETHUCMS_FIRESTORE_PREFIX must start with a letter and use only letters, digits, "_" and "-" (up to 41 characters)',
    );
  }
  return prefix;
}

/**
 * Connect to Firestore. The driver (`@google-cloud/firestore`) is loaded here,
 * so it is needed only when Firestore state is used.
 *
 * @throws Error if the credentials are not a service-account key, or the
 * driver is missing. Messages never repeat the credentials.
 */
export async function openFirestore(
  settings: FirestoreSettings,
): Promise<FirestoreLike> {
  let credentials: { client_email: string; private_key: string } | undefined;
  if (settings.credentialsJson) {
    try {
      const parsed = JSON.parse(settings.credentialsJson);
      if (
        typeof parsed?.client_email !== 'string' ||
        typeof parsed?.private_key !== 'string'
      ) {
        throw new Error('missing fields');
      }
      credentials = {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
      };
    } catch {
      throw new Error(
        'SETHUCMS_FIRESTORE_CREDENTIALS_JSON must be a Google service-account key (JSON with client_email and private_key)',
      );
    }
  }
  if (settings.emulatorHost) {
    // The driver reads this variable when it is created.
    process.env['FIRESTORE_EMULATOR_HOST'] = settings.emulatorHost;
  }
  // Loaded by name so the code compiles without the driver installed.
  const moduleName = '@google-cloud/firestore';
  let driver: { Firestore: new (options: object) => unknown };
  try {
    driver = (await import(moduleName)) as typeof driver;
  } catch {
    throw new Error(
      'Firestore state needs the "@google-cloud/firestore" package. Run: pnpm add @google-cloud/firestore (in apps/api)',
    );
  }
  return new driver.Firestore({
    projectId: settings.projectId,
    ignoreUndefinedProperties: true,
    ...(credentials ? { credentials } : {}),
  }) as FirestoreLike;
}

// ---------------------------------------------------------------------------
// State store

const KINDS = [
  'connections',
  'drafts',
  'tokens',
  'migrations',
  'webhooks',
] as const;
type Kind = (typeof KINDS)[number];

/** Lease: a gateway renews it every HEARTBEAT; others wait for LEASE to pass. */
const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
/** Firestore allows 500 writes per batch; stay well below. */
const BATCH_LIMIT = 400;

export interface FirestoreStateOptions {
  /** Take over a lease that is still live (recovery only). */
  force?: boolean;
  /** Test hooks. */
  now?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
  owner?: string;
}

// Firestore document ids may not contain "/" and may not be "." or "..".
const docId = (id: string): string => {
  if (id === '.' || id === '..' || id === '') {
    throw new Error('invalid record id');
  }
  return encodeURIComponent(id);
};

/**
 * State kept in Firestore. Safe for one gateway process.
 */
export class FirestoreStateStore extends MemoryStateStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** What Firestore holds now: "kind/id" -> JSON text. */
  private readonly written = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private lost = false;
  private released = false;

  private constructor(
    private readonly fs: FirestoreLike,
    private readonly prefix: string,
    private readonly owner: string,
    private readonly options: FirestoreStateOptions,
  ) {
    super();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private col(kind: string): FsCollection {
    return this.fs.collection(`${this.prefix}_${kind}`);
  }

  /**
   * Take the lease, then load everything.
   * @throws Error when another live gateway holds the lease, or the stored
   * format is newer than this gateway understands.
   */
  static async open(
    fs: FirestoreLike,
    prefix: string,
    options: FirestoreStateOptions = {},
  ): Promise<FirestoreStateStore> {
    const owner = options.owner ?? randomBytes(8).toString('hex');
    const store = new FirestoreStateStore(fs, prefix, owner, options);
    await store.acquire();
    try {
      await store.load();
    } catch (error) {
      await store.release();
      throw error;
    }
    const heartbeat = options.heartbeatMs ?? HEARTBEAT_MS;
    store.timer = setInterval(() => void store.renew(), heartbeat);
    store.timer.unref();
    return store;
  }

  private leaseRef(): FsDocRef {
    return this.col('meta').doc('lease');
  }

  private async acquire(): Promise<void> {
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    await this.fs.runTransaction(async (tx) => {
      const ref = this.leaseRef();
      const snap = await tx.get(ref);
      const held = snap.exists ? snap.data() : undefined;
      const live =
        held && held.owner !== this.owner && Number(held.expiresAt) > this.now();
      if (live && !this.options.force) {
        const seconds = Math.ceil((Number(held.expiresAt) - this.now()) / 1000);
        throw new Error(
          `Another SethuCMS gateway is using this Firestore state (its lease runs for about ${seconds} more seconds). Run one gateway per state. If the other one crashed, wait for the lease to pass, or set SETHUCMS_FORCE_LOCK=1`,
        );
      }
      tx.set(ref, { owner: this.owner, expiresAt: this.now() + leaseMs });
    });
  }

  /** Extend the lease; if someone else took it, stop accepting writes. */
  private async renew(): Promise<void> {
    if (this.released || this.lost) {
      return;
    }
    const leaseMs = this.options.leaseMs ?? LEASE_MS;
    try {
      await this.fs.runTransaction(async (tx) => {
        const ref = this.leaseRef();
        const snap = await tx.get(ref);
        const held = snap.exists ? snap.data() : undefined;
        if (held && held.owner !== this.owner) {
          this.lost = true;
          return;
        }
        tx.set(ref, { owner: this.owner, expiresAt: this.now() + leaseMs });
      });
    } catch {
      // A passing network problem: the lease is still valid until it expires.
    }
  }

  private async load(): Promise<void> {
    const metaRef = this.col('meta').doc('state');
    const meta = await metaRef.get();
    if (meta.exists) {
      if (meta.data()?.version !== 1) {
        throw new Error('The Firestore state has an unknown version');
      }
    } else {
      await metaRef.set({ version: 1 });
    }
    const state = emptyState();
    for (const kind of KINDS) {
      const snapshot = await this.col(kind).get();
      for (const doc of snapshot.docs) {
        const json = String(doc.data()?.json ?? '');
        const record = JSON.parse(json) as { id?: string };
        const id = record.id ?? decodeURIComponent(doc.id);
        (state[kind] as Record<string, unknown>)[id] = record;
        this.written.set(`${kind}/${id}`, json);
      }
    }
    this.state = state;
  }

  // Changes run one at a time. Firestore is written BEFORE memory changes, so
  // a failed write leaves the gateway's view exactly as it was.
  override update<T>(change: (state: State) => T): Promise<T> {
    const run = this.queue.then(async () => {
      if (this.lost) {
        throw new Error(
          'This gateway lost its Firestore lease to another gateway. Restart it',
        );
      }
      const draft = structuredClone(this.state);
      const result = change(draft);
      await this.save(draft);
      this.state = draft;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Write what differs from Firestore, in batches. */
  private async save(next: State): Promise<void> {
    type Op = { key: string; kind: Kind; id: string; json?: string };
    const ops: Op[] = [];
    const seen = new Set<string>();
    for (const kind of KINDS) {
      for (const [id, record] of Object.entries(
        next[kind] as Record<string, unknown>,
      )) {
        const key = `${kind}/${id}`;
        seen.add(key);
        const json = JSON.stringify(record);
        if (this.written.get(key) !== json) {
          ops.push({ key, kind, id, json });
        }
      }
    }
    for (const key of this.written.keys()) {
      if (!seen.has(key)) {
        const slash = key.indexOf('/');
        ops.push({
          key,
          kind: key.slice(0, slash) as Kind,
          id: key.slice(slash + 1),
        });
      }
    }
    for (let start = 0; start < ops.length; start += BATCH_LIMIT) {
      const slice = ops.slice(start, start + BATCH_LIMIT);
      const batch = this.fs.batch();
      for (const op of slice) {
        const ref = this.col(op.kind).doc(docId(op.id));
        if (op.json === undefined) {
          batch.delete(ref);
        } else {
          batch.set(ref, { json: op.json, updatedAt: this.now() });
        }
      }
      await batch.commit();
      for (const op of slice) {
        if (op.json === undefined) {
          this.written.delete(op.key);
        } else {
          this.written.set(op.key, op.json);
        }
      }
    }
  }

  /** Give the lease back so a restart is not refused. Safe to call twice. */
  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.queue.catch(() => undefined);
    try {
      await this.fs.runTransaction(async (tx) => {
        const ref = this.leaseRef();
        const snap = await tx.get(ref);
        if (snap.exists && snap.data()?.owner === this.owner) {
          tx.delete(ref);
        }
      });
    } catch {
      // The lease simply expires on its own.
    }
  }
}

// ---------------------------------------------------------------------------
// State shared by many gateways (serverless)

export interface SharedFirestoreOptions {
  /**
   * How long a loaded copy may be used before one cheap read checks for
   * changes made by another instance. 0 checks on every request. Default 1000.
   */
  staleMs?: number;
  now?: () => number;
}

/** A change may write at most this many documents (Firestore allows 500). */
const TX_LIMIT = 450;

/**
 * State for gateways that run as many short-lived instances at once (for
 * example on Vercel). There is no lease. A counter in `meta/state` goes up by
 * one with every change, and a change is saved in a transaction that checks
 * the counter, so two instances cannot overwrite each other: the second one
 * reloads the newest state and applies its change to that.
 *
 * Each request first asks `fresh()` whether the counter moved; a token revoked
 * on one instance stops working on the others within `staleMs`.
 */
export class SharedFirestoreStateStore extends MemoryStateStore {
  private queue: Promise<unknown> = Promise.resolve();
  private written = new Map<string, string>();
  private rev = -1;
  private checkedAt = 0;
  private refreshing: Promise<void> | undefined;

  private constructor(
    private readonly fs: FirestoreLike,
    private readonly prefix: string,
    private readonly options: SharedFirestoreOptions,
  ) {
    super();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private col(kind: string): FsCollection {
    return this.fs.collection(`${this.prefix}_${kind}`);
  }

  private metaRef(): FsDocRef {
    return this.col('meta').doc('state');
  }

  /**
   * Create the counter if it is missing, then load everything.
   * @throws Error when the stored format is newer than this gateway knows.
   */
  static async open(
    fs: FirestoreLike,
    prefix: string,
    options: SharedFirestoreOptions = {},
  ): Promise<SharedFirestoreStateStore> {
    const store = new SharedFirestoreStateStore(fs, prefix, options);
    await fs.runTransaction(async (tx) => {
      const ref = store.metaRef();
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, { version: 1, rev: 0 });
      }
    });
    await store.load();
    store.checkedAt = store.now();
    return store;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<void> {
    const meta = (await this.metaRef().get()).data();
    if (meta?.version !== 1) {
      throw new Error('The Firestore state has an unknown version');
    }
    // The counter is read first: if a change lands while the documents are
    // read, the counter is already behind and the next check reloads.
    const rev = Number(meta.rev ?? 0);
    const state = emptyState();
    const written = new Map<string, string>();
    for (const kind of KINDS) {
      const snapshot = await this.col(kind).get();
      for (const doc of snapshot.docs) {
        const json = String(doc.data()?.json ?? '');
        const record = JSON.parse(json) as { id?: string };
        const id = record.id ?? decodeURIComponent(doc.id);
        (state[kind] as Record<string, unknown>)[id] = record;
        written.set(`${kind}/${id}`, json);
      }
    }
    this.state = state;
    this.written = written;
    this.rev = rev;
  }

  /** Reload when the counter moved. */
  private async sync(): Promise<void> {
    const meta = (await this.metaRef().get()).data();
    if (Number(meta?.rev ?? 0) !== this.rev) {
      await this.load();
    }
    this.checkedAt = this.now();
  }

  /** Called at the start of every request. A failure keeps the copy we have. */
  fresh(): Promise<void> {
    const staleMs = this.options.staleMs ?? 1000;
    if (this.now() - this.checkedAt < staleMs) {
      return Promise.resolve();
    }
    this.refreshing ??= this.serial(() => this.sync())
      .catch(() => undefined)
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  override update<T>(change: (state: State) => T): Promise<T> {
    return this.serial(async () => {
      // Start from the newest state so `change` sees what other instances did.
      await this.sync();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (attempt > 0) {
          // Back off a little so instances that collide do not collide again.
          await new Promise((r) => setTimeout(r, Math.random() * 25 * attempt));
        }
        const draft = structuredClone(this.state);
        const result = change(draft);
        const ops = this.diff(draft);
        if (ops.length > TX_LIMIT) {
          throw new Error(
            'This change touches too many records to save at once',
          );
        }
        const outcome = await this.fs.runTransaction(async (tx) => {
          const snap = await tx.get(this.metaRef());
          const rev = Number(snap.data()?.rev ?? 0);
          if (rev !== this.rev) {
            return { stale: true as const };
          }
          for (const op of ops) {
            const ref = this.col(op.kind).doc(docId(op.id));
            if (op.json === undefined) {
              tx.delete(ref);
            } else {
              tx.set(ref, { json: op.json, updatedAt: this.now() });
            }
          }
          tx.set(this.metaRef(), { version: 1, rev: rev + 1 });
          return { stale: false as const, rev: rev + 1 };
        });
        if (outcome.stale) {
          // Someone saved between our check and our write: take theirs, retry.
          await this.load();
          continue;
        }
        for (const op of ops) {
          if (op.json === undefined) {
            this.written.delete(op.key);
          } else {
            this.written.set(op.key, op.json);
          }
        }
        this.state = draft;
        this.rev = outcome.rev;
        this.checkedAt = this.now();
        return result;
      }
      throw new Error('The saved state keeps changing; try again');
    });
  }

  private diff(
    next: State,
  ): Array<{ key: string; kind: Kind; id: string; json?: string }> {
    const ops: Array<{ key: string; kind: Kind; id: string; json?: string }> =
      [];
    const seen = new Set<string>();
    for (const kind of KINDS) {
      for (const [id, record] of Object.entries(
        next[kind] as Record<string, unknown>,
      )) {
        const key = `${kind}/${id}`;
        seen.add(key);
        const json = JSON.stringify(record);
        if (this.written.get(key) !== json) {
          ops.push({ key, kind, id, json });
        }
      }
    }
    for (const key of this.written.keys()) {
      if (!seen.has(key)) {
        const slash = key.indexOf('/');
        ops.push({
          key,
          kind: key.slice(0, slash) as Kind,
          id: key.slice(slash + 1),
        });
      }
    }
    return ops;
  }

  /** Nothing to give back: there is no lease. */
  async release(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Audit log

const MAX_TS = 9_999_999_999_999;
const MAX_N = 99_999_999;

export interface FirestoreAuditOptions {
  chain?: string;
  pageSize?: number;
  now?: () => number;
}

/**
 * The audit log in Firestore. Each gateway process writes its own hash chain
 * (see audit.ts); entries live in one collection whose document ids sort in
 * time order, so no index is needed.
 */
export class FirestoreAuditSink implements AuditSink {
  readonly chain: string;
  private n = 0;
  private last = 0;
  private readonly pageSize: number;

  constructor(
    private readonly fs: FirestoreLike,
    private readonly prefix: string,
    private readonly options: FirestoreAuditOptions = {},
  ) {
    this.chain = options.chain ?? randomBytes(4).toString('hex');
    this.pageSize = options.pageSize ?? 1000;
  }

  private col(): FsCollection {
    return this.fs.collection(`${this.prefix}_audit`);
  }

  async append(entry: AuditEntry): Promise<void> {
    // Strictly increasing within this chain, even if the clock steps back.
    const ts = Math.max((this.options.now ?? Date.now)(), this.last + 1);
    this.last = ts;
    this.n += 1;
    const id = `${String(ts).padStart(13, '0')}-${this.chain}-${String(this.n).padStart(8, '0')}`;
    // The emulator cannot scan backwards, so newest-first reads an ascending
    // key made from the time counted down.
    const newest = `${String(MAX_TS - ts).padStart(13, '0')}-${this.chain}-${String(MAX_N - this.n).padStart(8, '0')}`;
    await this.col()
      .doc(id)
      .set({ chain: this.chain, newest, json: JSON.stringify(entry) });
  }

  async latest(limit: number): Promise<AuditEntry[]> {
    const snapshot = await this.col()
      .orderBy('newest', 'asc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => JSON.parse(doc.data().json) as AuditEntry);
  }

  async *chains(): AsyncGenerator<{ chain: string; entries: AuditEntry[] }> {
    const byChain = new Map<string, AuditEntry[]>();
    let after: FsSnapshot | undefined;
    for (;;) {
      let query = this.col().orderBy('__name__', 'asc').limit(this.pageSize);
      if (after) {
        query = query.startAfter(after);
      }
      const page = await query.get();
      if (page.docs.length === 0) {
        break;
      }
      for (const doc of page.docs) {
        const data = doc.data();
        const list = byChain.get(data.chain) ?? [];
        list.push(JSON.parse(data.json) as AuditEntry);
        byChain.set(data.chain, list);
      }
      after = page.docs[page.docs.length - 1];
      if (page.docs.length < this.pageSize) {
        break;
      }
    }
    for (const chain of [...byChain.keys()].sort()) {
      yield { chain, entries: byChain.get(chain) as AuditEntry[] };
    }
  }
}

// ---------------------------------------------------------------------------
// Change feed and webhook queue

interface Snapshot {
  seq: number;
  events: ChangeRecord[];
  queue: Delivery[];
  nextDelivery: number;
}

export interface FirestoreChangeOptions {
  /** Characters per stored part (a document may hold about 1 MB). */
  partChars?: number;
  /** How often a changed feed is saved. Default 5000 ms. */
  flushMs?: number;
}

/**
 * The change feed in memory plus a snapshot saved to Firestore a few seconds
 * after each change. A crash can lose the last few seconds of changes, the
 * same trade the file store makes; for a guarantee use PostgreSQL.
 */
export class FirestoreChangeStore extends MemoryChangeStore {
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> = Promise.resolve();
  private parts = 0;

  private constructor(
    private readonly fs: FirestoreLike,
    private readonly prefix: string,
    private readonly partChars: number,
  ) {
    super();
  }

  private col(): FsCollection {
    return this.fs.collection(`${this.prefix}_changes`);
  }

  /** Load the saved snapshot, if any, and start the background save. */
  static async open(
    fs: FirestoreLike,
    prefix: string,
    options: FirestoreChangeOptions = {},
  ): Promise<FirestoreChangeStore> {
    const store = new FirestoreChangeStore(
      fs,
      prefix,
      options.partChars ?? 200_000,
    );
    try {
      const page = await store.col().orderBy('__name__', 'asc').get();
      if (page.docs.length > 0) {
        const text = page.docs.map((doc) => String(doc.data().part)).join('');
        const saved = JSON.parse(text) as Snapshot;
        store.seq = saved.seq;
        store.events = saved.events;
        store.queue = saved.queue;
        store.nextDelivery = saved.nextDelivery;
        store.parts = page.docs.length;
      }
    } catch {
      // A damaged snapshot must not stop the gateway; the feed restarts.
      process.stderr.write(
        'The saved change feed could not be read; starting an empty change feed\n',
      );
    }
    store.timer = setInterval(() => void store.flush(), options.flushMs ?? 5000);
    store.timer.unref();
    return store;
  }

  /** Save now if anything changed. Saves are serialised. */
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
        const text = JSON.stringify(snapshot);
        const count = Math.max(1, Math.ceil(text.length / this.partChars));
        const batch = this.fs.batch();
        for (let i = 0; i < count; i += 1) {
          batch.set(this.col().doc(`part-${String(i).padStart(4, '0')}`), {
            part: text.slice(i * this.partChars, (i + 1) * this.partChars),
          });
        }
        for (let i = count; i < this.parts; i += 1) {
          batch.delete(this.col().doc(`part-${String(i).padStart(4, '0')}`));
        }
        await batch.commit();
        this.parts = count;
      })
      .catch(() => {
        // Try again on the next tick.
        this.dirty = true;
      });
    await this.writing;
  }

  override async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.dirty = true;
    await this.flush();
  }
}
