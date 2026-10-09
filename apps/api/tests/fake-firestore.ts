/**
 * A small in-memory stand-in for Firestore, used because no Firestore emulator
 * is available in every environment. It copies the behaviours that matter to the
 * adapter: inequality filters only match values of the same type (so null never
 * matches "!="), documents missing an orderBy field are left out, ids sort as
 * text, create fails on an existing id, update and delete fail on a missing one.
 *
 * It is NOT proof that the adapter works against real Firestore.
 */
import type { FirestoreHandle } from '@sethucms/adapter-firestore';

type Data = Record<string, unknown>;
type Node =
  | { k: 'where'; f: string; op: string; v: unknown }
  | { k: 'and' | 'or'; c: Node[] };

const grpc = (code: number) =>
  Object.assign(new Error(`grpc ${code}`), { code });

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : a === b;
const bracket = (v: unknown) =>
  v instanceof Date ? 'date' : v === null ? 'null' : typeof v;
// Ordering mirrors Firestore: null sorts first, Dates compare by time.
function compare(a: unknown, b: unknown): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return -1;
  }
  if (b === null) {
    return 1;
  }
  const x = a instanceof Date ? a.getTime() : (a as number | string | boolean);
  const y = b instanceof Date ? b.getTime() : (b as number | string | boolean);
  return x < y ? -1 : x > y ? 1 : 0;
}

// Matching copies Firestore quirks the adapter depends on - inequality only
// matches same-type values, so null never matches != or range filters.
function matches(node: Node, id: string, data: Data): boolean {
  if (node.k !== 'where') {
    return node.k === 'and'
      ? node.c.every((child) => matches(child, id, data))
      : node.c.some((child) => matches(child, id, data));
  }
  const value = node.f === '__name__' ? id : data[node.f];
  const exists = node.f === '__name__' || Object.hasOwn(data, node.f);
  const v = node.v;
  switch (node.op) {
    case '==':
      return exists && same(value, v);
    case '!=':
      return (
        exists &&
        value !== null &&
        bracket(value) === bracket(v) &&
        !same(value, v)
      );
    case '<':
      return exists && bracket(value) === bracket(v) && compare(value, v) < 0;
    case '<=':
      return exists && bracket(value) === bracket(v) && compare(value, v) <= 0;
    case '>':
      return exists && bracket(value) === bracket(v) && compare(value, v) > 0;
    case '>=':
      return exists && bracket(value) === bracket(v) && compare(value, v) >= 0;
    case 'in':
      return exists && (v as unknown[]).some((item) => same(value, item));
    case 'not-in':
      return (
        exists &&
        value !== null &&
        !(v as unknown[]).some((item) => same(value, item))
      );
    case 'array-contains':
      return Array.isArray(value) && value.some((item) => same(item, v));
    default:
      // Unknown operators fail loudly (INVALID_ARGUMENT) rather than quietly
      // matching everything.
      throw grpc(3);
  }
}

export function createFakeFirestore(): FirestoreHandle & {
  store: Map<string, Map<string, Data>>;
} {
  const store = new Map<string, Map<string, Data>>();
  const table = (name: string) => {
    let t = store.get(name);
    if (!t) {
      t = new Map();
      store.set(name, t);
    }
    return t;
  };

  const docRef = (name: string, id: string) => ({
    id,
    coll: name,
    // Values are cloned on read and write so the adapter cannot mutate stored
    // documents by reference.
    async get() {
      const data = store.get(name)?.get(id);
      return {
        exists: data !== undefined,
        id,
        data: () => structuredClone(data ?? {}),
      };
    },
    async create(data: Data) {
      // Code 6 is ALREADY_EXISTS and 5 is NOT_FOUND, the gRPC codes the adapter
      // maps to its own errors.
      if (store.get(name)?.has(id)) {
        throw grpc(6);
      }
      table(name).set(id, structuredClone(data));
    },
    async set(data: Data) {
      table(name).set(id, structuredClone(data));
    },
    async update(data: Data) {
      const current = store.get(name)?.get(id);
      if (!current) {
        throw grpc(5);
      }
      table(name).set(id, { ...current, ...structuredClone(data) });
    },
    async delete(precondition?: { exists?: boolean }) {
      if (precondition?.exists && !store.get(name)?.has(id)) {
        throw grpc(5);
      }
      store.get(name)?.delete(id);
      if (store.get(name)?.size === 0) {
        store.delete(name);
      }
    },
  });

  const query = (
    name: string,
    state: {
      filter?: Node;
      order: Array<[string, string]>;
      select?: string[];
      offset: number;
      limit?: number;
    },
  ) => ({
    where: (filter: Node) => query(name, { ...state, filter }),
    orderBy: (field: string, dir = 'asc') =>
      query(name, { ...state, order: [...state.order, [field, dir]] }),
    select: (...fields: string[]) => query(name, { ...state, select: fields }),
    offset: (n: number) => query(name, { ...state, offset: n }),
    limit: (n: number) => query(name, { ...state, limit: n }),
    async get() {
      let rows = [...(store.get(name)?.entries() ?? [])].filter(
        ([id, data]) => !state.filter || matches(state.filter, id, data),
      );
      // Documents without the sort field must vanish, as in real Firestore, or
      // pagination tests would pass wrongly.
      for (const [field] of state.order) {
        if (field !== '__name__') {
          rows = rows.filter(([, data]) => Object.hasOwn(data, field));
        } // Firestore leaves out documents without the sort field
      }
      // Firestore always tie-breaks by document id, which keeps cursors stable.
      const order = state.order.some(([f]) => f === '__name__')
        ? state.order
        : [...state.order, ['__name__', 'asc'] as [string, string]];
      rows.sort(([ia, a], [ib, b]) => {
        for (const [field, dir] of order) {
          const c =
            field === '__name__'
              ? ia < ib
                ? -1
                : ia > ib
                  ? 1
                  : 0
              : compare(a[field], b[field]);
          if (c !== 0) {
            return dir === 'desc' ? -c : c;
          }
        }
        return 0;
      });
      rows = rows.slice(
        state.offset,
        state.limit === undefined ? undefined : state.offset + state.limit,
      );
      return {
        docs: rows.map(([id, data]) => ({
          id,
          data: () =>
            structuredClone(
              state.select
                ? Object.fromEntries(
                    Object.entries(data).filter(([k]) =>
                      state.select!.includes(k),
                    ),
                  )
                : data,
            ),
        })),
      };
    },
  });

  const db = {
    collection: (name: string) => ({
      doc: (id?: string) =>
        docRef(name, id ?? `auto${Math.random().toString(36).slice(2, 12)}`),
      ...query(name, { order: [], offset: 0 }),
    }),
    async listCollections() {
      return [...store.keys()].map((id) => ({ id }));
    },
    // Writes are buffered and applied only after the callback, so a failed
    // create leaves nothing partial.
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const writes: Array<{
        kind: 'create' | 'set';
        coll: string;
        id: string;
        data: Data;
      }> = [];
      type Ref = { coll: string; id: string; get(): Promise<unknown> };
      const tx = {
        get: (ref: Ref) => ref.get(),
        create: (ref: Ref, data: Data) => {
          writes.push({ kind: 'create', coll: ref.coll, id: ref.id, data });
        },
        set: (ref: Ref, data: Data) => {
          writes.push({ kind: 'set', coll: ref.coll, id: ref.id, data });
        },
      };
      const result = await fn(tx);
      // All or nothing: a create on an id that exists fails before anything is written.
      if (
        writes.some((w) => w.kind === 'create' && store.get(w.coll)?.has(w.id))
      ) {
        throw grpc(6);
      }
      for (const w of writes) {
        table(w.coll).set(w.id, structuredClone(w.data));
      }
      return result;
    },
    async terminate() {},
  };
  const Filter = {
    where: (f: string, op: string, v: unknown): Node => ({
      k: 'where',
      f,
      op,
      v,
    }),
    and: (...c: Node[]): Node => ({ k: 'and', c }),
    or: (...c: Node[]): Node => ({ k: 'or', c }),
  };
  return { db, Filter, close: async () => undefined, store } as never;
}
