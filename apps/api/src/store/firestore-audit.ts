/**
 * The audit log in Firestore.
 */
import { randomBytes } from 'node:crypto';
import type { AuditEntry, AuditSink } from '../audit.js';

import {
  type FirestoreLike,
  type FsCollection,
  type FsSnapshot,
} from './firestore-client.js';

// ---------------------------------------------------------------------------
// Audit log

export const MAX_TS = 9_999_999_999_999;
export const MAX_N = 99_999_999;

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
