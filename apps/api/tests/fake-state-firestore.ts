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
      field: string,
      max: number,
      after: string | undefined,
    ): FsQuery => ({
      orderBy: (by, dir = 'asc') => {
        // The Firestore emulator refuses descending scans; so does this fake.
        if (dir !== 'asc') {
          throw new Error('9 FAILED_PRECONDITION: no descending scans');
        }
        return make(by, max, after);
      },
      limit: (count) => make(field, count, after),
      startAfter: (snap) => make(field, max, snap.id),
      get: async (): Promise<FsQuerySnapshot> => {
        const table = this.data.get(name) ?? new Map<string, any>();
        const key = (id: string): string =>
          field === '__name__' ? id : String(table.get(id)?.[field] ?? '');
        let ids = [...table.keys()].sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
        if (after !== undefined) {
          const cut = ids.indexOf(after);
          ids = cut >= 0 ? ids.slice(cut + 1) : ids;
        }
        return { docs: ids.slice(0, max).map((id) => this.snapshot(name, id)) };
      },
    });
    return {
      ...make('__name__', Number.MAX_SAFE_INTEGER, undefined),
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
