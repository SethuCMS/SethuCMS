/**
 * The change feed and webhook queue in Firestore.
 */
import { MemoryChangeStore } from '../changes/store.js';
import type { ChangeRecord, Delivery } from '../changes/store.js';

import { type FirestoreLike, type FsCollection } from './firestore-client.js';

// ---------------------------------------------------------------------------
// Change feed and webhook queue

export interface Snapshot {
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
