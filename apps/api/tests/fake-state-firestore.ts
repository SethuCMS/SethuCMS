/**
 * A small in-memory stand-in for the part of Firestore the gateway's state
 * store uses (see store/firestore.ts). It checks what the real service
 * enforces and the code relies on: documents are plain objects, a batch is
 * all-or-nothing, a transaction sees a consistent read, a document id cannot
 * contain "/", and queries order by document id.
 */
import type {
  FirestoreLike,
  FsBatch,
  FsCollection,
  FsDocRef,
  FsQuery,
  FsQuerySnapshot,
  FsSnapshot,
  FsTransaction,
} from '../src/store/firestore.js';

export class FakeStateFirestore implements FirestoreLike {
  /** collection name -> document id -> data */
  readonly data = new Map<string, Map<string, any>>();
  /** Make the next N batch commits fail, to test failed writes. */
  failBatches = 0;
  batchCommits = 0;
  private lock: Promise<unknown> = Promise.resolve();

  private table(name: string): Map<string, any> {
    let table = this.data.get(name);
    if (!table) {
      table = new Map();
      this.data.set(name, table);
    }
    return table;
  }

  private snapshot(name: string, id: string): FsSnapshot {
    const row = this.data.get(name)?.get(id);
    return {
      id,
      exists: row !== undefined,
      data: () => (row === undefined ? undefined : structuredClone(row)),
    };
  }

  private ref(name: string, id: string): FsDocRef & { collection: string } {
    if (id.includes('/') || id === '.' || id === '..' || id === '') {
      throw new Error(`invalid document id: ${id}`);
    }
    return {
      id,
      collection: name,
      get: async () => this.snapshot(name, id),
      set: async (value: any) => {
        this.table(name).set(id, structuredClone(value));
      },
      delete: async () => {
        this.table(name).delete(id);
      },
    };
  }

  collection(name: string): FsCollection {
    const make = (
      direction: 'asc' | 'desc',
      max: number,
      after: string | undefined,
    ): FsQuery => ({
      orderBy: (field, dir = 'asc') => {
        if (field !== '__name__') {
          throw new Error('the fake only orders by document id');
        }
        return make(dir, max, after);
      },
      limit: (count) => make(direction, count, after),
      startAfter: (snap) => make(direction, max, snap.id),
      get: async (): Promise<FsQuerySnapshot> => {
        let ids = [...(this.data.get(name)?.keys() ?? [])].sort();
        if (direction === 'desc') {
          ids.reverse();
        }
        if (after !== undefined) {
          ids = ids.filter((id) => (direction === 'asc' ? id > after : id < after));
        }
        return { docs: ids.slice(0, max).map((id) => this.snapshot(name, id)) };
      },
    });
    return {
      ...make('asc', Number.MAX_SAFE_INTEGER, undefined),
      doc: (id: string) => this.ref(name, id),
    };
  }

  batch(): FsBatch {
    const ops: Array<() => void> = [];
    const batch: FsBatch = {
      set: (ref, value) => {
        const r = ref as FsDocRef & { collection: string };
        ops.push(() => this.table(r.collection).set(r.id, structuredClone(value)));
        return batch;
      },
      delete: (ref) => {
        const r = ref as FsDocRef & { collection: string };
        ops.push(() => this.table(r.collection).delete(r.id));
        return batch;
      },
      commit: async () => {
        if (this.failBatches > 0) {
          this.failBatches -= 1;
          throw new Error('simulated Firestore failure');
        }
        this.batchCommits += 1;
        for (const op of ops) {
          op();
        }
      },
    };
    return batch;
  }

  // One transaction at a time, which is the strongest guarantee Firestore
  // gives; writes apply only if the callback finishes without throwing.
  async runTransaction<T>(work: (tx: FsTransaction) => Promise<T>): Promise<T> {
    const run = this.lock.then(async () => {
      const writes: Array<() => void> = [];
      const tx: FsTransaction = {
        get: async (ref) => {
          const r = ref as FsDocRef & { collection: string };
          return this.snapshot(r.collection, r.id);
        },
        set: (ref, value) => {
          const r = ref as FsDocRef & { collection: string };
          writes.push(() => this.table(r.collection).set(r.id, structuredClone(value)));
          return tx;
        },
        delete: (ref) => {
          const r = ref as FsDocRef & { collection: string };
          writes.push(() => this.table(r.collection).delete(r.id));
          return tx;
        },
      };
      const result = await work(tx);
      for (const write of writes) {
        write();
      }
      return result;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  async terminate(): Promise<void> {}
}
