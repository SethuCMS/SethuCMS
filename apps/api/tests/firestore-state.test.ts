// The gateway's own state in Firestore: saved state, the single-gateway lease,
// the audit log and the change feed. Runs against an in-memory fake, so it
// needs no Google account or emulator. Whether the real service behaves the
// same is covered by the live test (firestore-state.live.test.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AuditEntry } from '../src/audit.js';
import {
  FirestoreAuditSink,
  FirestoreChangeStore,
  FirestoreStateStore,
  firestorePrefix,
  openFirestore,
} from '../src/store/firestore.js';
import { FakeStateFirestore } from './fake-state-firestore.js';

const connection = (id: string): any => ({
  id,
  name: `Connection ${id}`,
  adapterType: 'memory',
  mode: 'read_only',
  config: { 'odd.key': 1, nested: { a: [1, 2] } },
  credentials: 'encrypted-blob',
  exposed: ['notes'],
  known: [],
  createdAt: '2026-10-10T00:00:00.000Z',
  updatedAt: '2026-10-10T00:00:00.000Z',
});

const entry = (n: number): AuditEntry => ({
  id: `a${n}`,
  at: new Date(1_700_000_000_000 + n).toISOString(),
  actor: 'tok_1',
  operation: 'test',
  target: `thing:${n}`,
});

describe('state in Firestore', () => {
  it('survives a restart', async () => {
    const fs = new FakeStateFirestore();
    const a = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    await a.update((state) => {
      state.connections['conn_1'] = connection('conn_1');
      state.tokens['tok_1'] = {
        id: 'tok_1',
        name: 'Admin',
        role: 'admin',
        hash: 'abc',
        createdAt: 'x',
      } as any;
    });
    await a.release();

    const b = await FirestoreStateStore.open(fs, 'p', { owner: 'b' });
    assert.equal(b.read().connections['conn_1']?.name, 'Connection conn_1');
    assert.deepEqual(b.read().connections['conn_1']?.config, {
      'odd.key': 1,
      nested: { a: [1, 2] },
    });
    assert.equal(b.read().tokens['tok_1']?.role, 'admin');
    await b.release();
  });

  it('writes only what changed, and removes what was deleted', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    await store.update((state) => {
      state.connections['c1'] = connection('c1');
      state.connections['c2'] = connection('c2');
    });
    assert.equal(fs.data.get('p_connections')?.size, 2);

    // A change that touches nothing must not write.
    const before = fs.batchCommits;
    await store.update(() => undefined);
    assert.equal(fs.batchCommits, before);

    await store.update((state) => {
      delete state.connections['c1'];
    });
    assert.deepEqual([...(fs.data.get('p_connections')?.keys() ?? [])], ['c2']);
    await store.release();
  });

  it('keeps ids with unusual characters', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    await store.update((state) => {
      state.connections['a/b c'] = connection('a/b c');
    });
    await store.release();
    const again = await FirestoreStateStore.open(fs, 'p', { owner: 'b' });
    assert.ok(again.read().connections['a/b c']);
    await again.release();
  });

  it('leaves memory unchanged when the write fails, and recovers', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    fs.failBatches = 1;
    await assert.rejects(
      store.update((state) => {
        state.connections['c1'] = connection('c1');
      }),
      /simulated/,
    );
    assert.equal(store.read().connections['c1'], undefined);
    // The next change writes everything that is missing.
    await store.update((state) => {
      state.connections['c1'] = connection('c1');
    });
    assert.ok(fs.data.get('p_connections')?.has('c1'));
    await store.release();
  });

  it('leaves memory unchanged when the change itself throws', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    await assert.rejects(
      store.update((state) => {
        state.connections['c1'] = connection('c1');
        throw new Error('nope');
      }),
      /nope/,
    );
    assert.equal(store.read().connections['c1'], undefined);
    await store.release();
  });

  it('applies concurrent changes one at a time without losing any', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.update((state) => {
          state.connections[`c${i}`] = connection(`c${i}`);
        }),
      ),
    );
    assert.equal(Object.keys(store.read().connections).length, 25);
    assert.equal(fs.data.get('p_connections')?.size, 25);
    await store.release();
  });

  it('splits a large change into several batches', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    await store.update((state) => {
      for (let i = 0; i < 1000; i += 1) {
        state.drafts[`d${i}`] = { id: `d${i}`, values: 'x' } as any;
      }
    });
    assert.equal(fs.data.get('p_drafts')?.size, 1000);
    assert.ok(fs.batchCommits >= 3);
    await store.release();
  });

  it('refuses a stored format it does not know', async () => {
    const fs = new FakeStateFirestore();
    await fs.collection('p_meta').doc('state').set({ version: 2 });
    await assert.rejects(
      FirestoreStateStore.open(fs, 'p', { owner: 'a' }),
      /unknown version/,
    );
    // And it gave the lease back, so it does not block a fixed start.
    assert.equal(fs.data.get('p_meta')?.has('lease'), false);
  });
});

describe('one gateway at a time', () => {
  it('refuses a second gateway while the first holds the lease', async () => {
    const fs = new FakeStateFirestore();
    const first = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    await assert.rejects(
      FirestoreStateStore.open(fs, 'p', { owner: 'b' }),
      /Another SethuCMS gateway is using this Firestore state/,
    );
    await first.release();
    const second = await FirestoreStateStore.open(fs, 'p', { owner: 'b' });
    await second.release();
  });

  it('takes over an expired lease (a crashed gateway)', async () => {
    const fs = new FakeStateFirestore();
    let clock = 1_000_000;
    const first = await FirestoreStateStore.open(fs, 'p', {
      owner: 'a',
      now: () => clock,
      leaseMs: 30_000,
      heartbeatMs: 3_600_000,
    });
    clock += 31_000; // the first gateway never renewed
    const second = await FirestoreStateStore.open(fs, 'p', {
      owner: 'b',
      now: () => clock,
    });
    await second.release();
    await first.release();
  });

  it('lets a deliberate takeover happen with force', async () => {
    const fs = new FakeStateFirestore();
    const first = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    const second = await FirestoreStateStore.open(fs, 'p', {
      owner: 'b',
      force: true,
    });
    // The first one now knows it lost the lease and stops writing.
    await (first as any).renew();
    await assert.rejects(
      first.update((state) => {
        state.connections['x'] = connection('x');
      }),
      /lost its Firestore lease/,
    );
    await second.release();
    await first.release();
  });

  it('does not delete a lease it no longer owns when released', async () => {
    const fs = new FakeStateFirestore();
    const first = await FirestoreStateStore.open(fs, 'p', { owner: 'a' });
    const second = await FirestoreStateStore.open(fs, 'p', {
      owner: 'b',
      force: true,
    });
    await first.release();
    assert.equal(fs.data.get('p_meta')?.get('lease')?.owner, 'b');
    await second.release();
  });
});

describe('audit log in Firestore', () => {
  it('lists the newest entries first', async () => {
    const fs = new FakeStateFirestore();
    const sink = new FirestoreAuditSink(fs, 'p', { chain: 'aaaa' });
    for (let i = 1; i <= 5; i += 1) {
      await sink.append(entry(i));
    }
    const latest = await sink.latest(3);
    assert.deepEqual(
      latest.map((item) => item.id),
      ['a5', 'a4', 'a3'],
    );
  });

  it('keeps each chain in order, across restarts and in pages', async () => {
    const fs = new FakeStateFirestore();
    const one = new FirestoreAuditSink(fs, 'p', { chain: 'bbbb', pageSize: 2 });
    const two = new FirestoreAuditSink(fs, 'p', { chain: 'aaaa', pageSize: 2 });
    await one.append(entry(1));
    await two.append(entry(2));
    await one.append(entry(3));
    await two.append(entry(4));
    await one.append(entry(5));

    const seen: Record<string, string[]> = {};
    for await (const { chain, entries } of one.chains()) {
      seen[chain] = entries.map((item) => item.id);
    }
    assert.deepEqual(seen, { aaaa: ['a2', 'a4'], bbbb: ['a1', 'a3', 'a5'] });
  });

  it('keeps one chain in order even if the clock steps back', async () => {
    const fs = new FakeStateFirestore();
    let now = 5_000_000_000_000;
    const sink = new FirestoreAuditSink(fs, 'p', { chain: 'cccc', now: () => now });
    await sink.append(entry(1));
    now -= 60_000;
    await sink.append(entry(2));
    now += 1;
    await sink.append(entry(3));
    const out: string[] = [];
    for await (const { entries } of sink.chains()) {
      out.push(...entries.map((item) => item.id));
    }
    assert.deepEqual(out, ['a1', 'a2', 'a3']);
  });

  it('gives each process its own chain', () => {
    const fs = new FakeStateFirestore();
    assert.notEqual(
      new FirestoreAuditSink(fs, 'p').chain,
      new FirestoreAuditSink(fs, 'p').chain,
    );
  });
});

describe('change feed in Firestore', () => {
  const event = (id: string): any => ({
    type: 'record.created',
    connectionId: 'conn_1',
    collection: 'notes',
    recordId: id,
  });

  it('numbers events, queues deliveries and survives a restart', async () => {
    const fs = new FakeStateFirestore();
    const a = await FirestoreChangeStore.open(fs, 'p', { flushMs: 3_600_000 });
    assert.equal(await a.append(event('1'), ['hook_1']), 1);
    assert.equal(await a.append(event('2'), ['hook_1']), 2);
    await a.close();

    const b = await FirestoreChangeStore.open(fs, 'p', { flushMs: 3_600_000 });
    assert.equal(await b.head(), 2);
    assert.equal((await b.since(0, 10)).length, 2);
    // The next event continues the numbering.
    assert.equal(await b.append(event('3'), []), 3);
    const claimed = await b.claim(10, 1000);
    assert.equal(claimed.length, 2);
    await b.complete(claimed[0]!.id, { ok: true, status: 200 });
    assert.equal((await b.counts()).delivered, 1);
    await b.close();
  });

  it('splits a large feed into parts and removes parts it no longer needs', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreChangeStore.open(fs, 'p', {
      partChars: 300,
      flushMs: 3_600_000,
    });
    for (let i = 0; i < 20; i += 1) {
      await store.append(event(String(i)), []);
    }
    await store.flush();
    const parts = fs.data.get('p_changes')?.size ?? 0;
    assert.ok(parts > 3, `expected several parts, got ${parts}`);

    const reopened = await FirestoreChangeStore.open(fs, 'p', {
      partChars: 300,
      flushMs: 3_600_000,
    });
    assert.equal(await reopened.head(), 20);

    // Pruning shrinks the snapshot; the extra parts must go.
    (reopened as any).events = (reopened as any).events.slice(-2);
    (reopened as any).dirty = true;
    await reopened.flush();
    assert.ok((fs.data.get('p_changes')?.size ?? 0) < parts);
    const third = await FirestoreChangeStore.open(fs, 'p', {
      partChars: 300,
      flushMs: 3_600_000,
    });
    assert.equal((await third.since(0, 100)).length, 2);
    await Promise.all([store.close(), reopened.close(), third.close()]);
  });

  it('keeps unsaved changes marked when saving fails', async () => {
    const fs = new FakeStateFirestore();
    const store = await FirestoreChangeStore.open(fs, 'p', { flushMs: 3_600_000 });
    await store.append(event('1'), []);
    fs.failBatches = 1;
    await store.flush(); // swallowed, stays dirty
    await store.flush(); // retried
    const again = await FirestoreChangeStore.open(fs, 'p', { flushMs: 3_600_000 });
    assert.equal(await again.head(), 1);
    await Promise.all([store.close(), again.close()]);
  });

  it('starts empty when the saved snapshot is damaged', async () => {
    const fs = new FakeStateFirestore();
    await fs.collection('p_changes').doc('part-0000').set({ part: '{not json' });
    const store = await FirestoreChangeStore.open(fs, 'p', { flushMs: 3_600_000 });
    assert.equal(await store.head(), 0);
    await store.close();
  });
});

describe('settings', () => {
  it('accepts a safe collection prefix and rejects an unsafe one', () => {
    assert.equal(firestorePrefix({}), 'sethucms');
    assert.equal(firestorePrefix({ prefix: 'acme-prod_1' }), 'acme-prod_1');
    for (const bad of ['', '1abc', 'a/b', 'a b', 'x'.repeat(60), '../x']) {
      assert.throws(() => firestorePrefix({ prefix: bad }), /PREFIX/);
    }
  });

  it('rejects credentials that are not a service-account key, without echoing them', async () => {
    for (const bad of ['not json', '{}', '{"client_email":"a@b"}']) {
      await assert.rejects(
        openFirestore({ projectId: 'p', credentialsJson: bad }),
        (error: Error) =>
          /service-account key/.test(error.message) && !error.message.includes(bad),
      );
    }
  });
});
