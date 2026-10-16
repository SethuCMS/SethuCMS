/**
 * The gateway's own state in Firestore for many gateways at once (serverless).
 */
import { emptyState, MemoryStateStore, type State } from './state.js';

import {
  type FirestoreLike,
  type FsCollection,
  type FsDocRef,
} from './firestore-client.js';
import { KINDS, type Kind, docId } from './firestore-state.js';

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
export const TX_LIMIT = 450;

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
