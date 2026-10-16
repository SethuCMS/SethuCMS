/**
 * The gateway's own state in Firestore for a single gateway (with a lease).
 */
import { randomBytes } from 'node:crypto';
import { emptyState, MemoryStateStore, type State } from './state.js';

import {
  type FirestoreLike,
  type FsCollection,
  type FsDocRef,
} from './firestore-client.js';

// ---------------------------------------------------------------------------
// State store

export const KINDS = [
  'connections',
  'drafts',
  'tokens',
  'migrations',
  'webhooks',
  'people',
  'invites',
  'fileUsage',
] as const;
export type Kind = (typeof KINDS)[number];

/** Lease: a gateway renews it every HEARTBEAT; others wait for LEASE to pass. */
export const LEASE_MS = 30_000;
export const HEARTBEAT_MS = 10_000;
/** Firestore allows 500 writes per batch; stay well below. */
export const BATCH_LIMIT = 400;

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
export const docId = (id: string): string => {
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
