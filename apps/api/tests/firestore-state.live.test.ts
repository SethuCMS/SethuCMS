// The gateway's Firestore state against the REAL Firestore driver talking to
// the emulator (or a real project). Skipped unless this is set:
//   SETHUCMS_TEST_FIRESTORE_EMULATOR   host:port, for example 127.0.0.1:8080
// Everything uses a random collection prefix, so runs do not meet.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { AuditEntry } from '../src/audit.js';
import {
  FirestoreAuditSink,
  FirestoreChangeStore,
  FirestoreStateStore,
  SharedFirestoreStateStore,
  openFirestore,
  type FirestoreLike,
} from '../src/store/firestore.js';
import { ADMIN_TOKEN, startGateway } from './helpers.js';

const emulatorHost = process.env['SETHUCMS_TEST_FIRESTORE_EMULATOR'];
const skip = emulatorHost ? false : 'set SETHUCMS_TEST_FIRESTORE_EMULATOR to run';
const prefix = `t${randomBytes(4).toString('hex')}`;

const clients: FirestoreLike[] = [];
const connect = async (): Promise<FirestoreLike> => {
  const fs = await openFirestore({
    projectId: 'demo-sethucms',
    emulatorHost: emulatorHost as string,
  });
  clients.push(fs);
  return fs;
};

after(async () => {
  for (const fs of clients) {
    await fs.terminate?.();
  }
});

const token = (id: string): any => ({
  id,
  name: `token ${id}`,
  role: 'viewer',
  hash: `hash-${id}`,
  createdAt: '2026-10-10T00:00:00.000Z',
});

const entry = (n: number): AuditEntry => ({
  id: `a${n}`,
  at: new Date(1_700_000_000_000 + n).toISOString(),
  actor: 'tok_1',
  operation: 'test',
  target: `thing:${n}`,
});

describe('state in real Firestore (single gateway)', { skip }, () => {
  it('keeps changes across a restart and refuses a second gateway', async () => {
    const fs = await connect();
    const p = `${prefix}_single`;
    const first = await FirestoreStateStore.open(fs, p);
    await first.update((s) => {
      s.tokens['odd/id'] = token('odd/id');
      s.tokens['plain'] = token('plain');
    });
    await assert.rejects(() => FirestoreStateStore.open(fs, p), /Another SethuCMS gateway/);
    await first.release();

    const second = await FirestoreStateStore.open(fs, p);
    assert.ok(second.read().tokens['odd/id'], 'an id with a slash survives');
    assert.ok(second.read().tokens['plain']);
    await second.update((s) => {
      delete s.tokens['plain'];
    });
    await second.release();

    const third = await FirestoreStateStore.open(fs, p);
    assert.equal(third.read().tokens['plain'], undefined, 'a deletion is saved');
    await third.release();
  });
});

describe('state in real Firestore (serverless, many instances)', { skip }, () => {
  it('loses nothing when instances save at the same time', async () => {
    const p = `${prefix}_shared`;
    const a = await SharedFirestoreStateStore.open(await connect(), p, { staleMs: 0 });
    const b = await SharedFirestoreStateStore.open(await connect(), p, { staleMs: 0 });
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        (i % 2 === 0 ? a : b).update((s) => {
          s.tokens[`t${i}`] = token(`t${i}`);
        }),
      ),
    );
    await a.fresh();
    await b.fresh();
    for (const store of [a, b]) {
      const ids = Object.keys(store.read().tokens);
      assert.equal(ids.length, 16, `every token is visible, got ${ids.length}`);
    }
  });

  it('shows one instance a deletion made by another', async () => {
    const p = `${prefix}_shared2`;
    const a = await SharedFirestoreStateStore.open(await connect(), p, { staleMs: 0 });
    const b = await SharedFirestoreStateStore.open(await connect(), p, { staleMs: 0 });
    await a.update((s) => {
      s.tokens['x'] = token('x');
    });
    await b.fresh();
    assert.ok(b.read().tokens['x']);
    await b.update((s) => {
      delete s.tokens['x'];
    });
    await a.fresh();
    assert.equal(a.read().tokens['x'], undefined);
  });
});

describe('audit log and change feed in real Firestore', { skip }, () => {
  it('lists audit entries newest first and keeps each chain in order', async () => {
    const fs = await connect();
    const p = `${prefix}_audit`;
    const one = new FirestoreAuditSink(fs, p, { chain: 'bbbb', pageSize: 2 });
    const two = new FirestoreAuditSink(fs, p, { chain: 'aaaa', pageSize: 2 });
    for (const [sink, n] of [[one, 1], [two, 2], [one, 3], [two, 4], [one, 5]] as const) {
      await sink.append(entry(n));
    }
    assert.deepEqual(
      (await one.latest(3)).map((e) => e.id),
      ['a5', 'a4', 'a3'],
    );
    const seen: Record<string, string[]> = {};
    for await (const { chain, entries } of one.chains()) {
      seen[chain] = entries.map((e) => e.id);
    }
    assert.deepEqual(seen, { aaaa: ['a2', 'a4'], bbbb: ['a1', 'a3', 'a5'] });
  });

  it('numbers change events and survives a restart', async () => {
    const fs = await connect();
    const p = `${prefix}_changes`;
    const event = (id: string): any => ({
      type: 'record.created',
      connectionId: 'conn_1',
      collection: 'notes',
      recordId: id,
    });
    const a = await FirestoreChangeStore.open(fs, p, { flushMs: 3_600_000 });
    assert.equal(await a.append(event('1'), ['hook_1']), 1);
    assert.equal(await a.append(event('2'), ['hook_1']), 2);
    await a.close();
    const b = await FirestoreChangeStore.open(fs, p, { flushMs: 3_600_000 });
    assert.equal(await b.head(), 2);
    assert.equal(await b.append(event('3'), []), 3);
    await b.close();
  });
});

describe('the gateway on real Firestore', { skip }, () => {
  const secrets = (): NodeJS.ProcessEnv => ({
    SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
    SETHUCMS_VAULT_KEY: randomBytes(32).toString('base64'),
    SETHUCMS_CURSOR_SECRET: randomBytes(32).toString('base64'),
    SETHUCMS_PREVIEW_SECRET: randomBytes(32).toString('base64'),
  });

  it('serverless: a token made on one instance works on another', async () => {
    const env = secrets();
    const settings = {
      seedDemo: false,
      serverless: true,
      worker: false,
      statePollMs: 0,
      firestore: {
        projectId: 'demo-sethucms',
        prefix: `${prefix}_gw1`,
        emulatorHost: emulatorHost as string,
      },
    };
    const a = await startGateway(settings, { env });
    const b = await startGateway(settings, { env });
    try {
      const made = await a.call('POST', '/v1/admin/tokens', {
        body: { name: 'live', role: 'editor' },
      });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const t = made.body.data.token as string;
      assert.equal((await b.call('GET', '/v1/connections', { token: t })).status, 200);
      await b.call('DELETE', `/v1/admin/tokens/${made.body.data.id as string}`);
      assert.equal((await a.call('GET', '/v1/connections', { token: t })).status, 401);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('single gateway: connections survive a restart', async () => {
    const env = secrets();
    const settings = {
      seedDemo: false,
      firestore: {
        projectId: 'demo-sethucms',
        prefix: `${prefix}_gw2`,
        emulatorHost: emulatorHost as string,
      },
    };
    const first = await startGateway(settings, { env });
    const created = await first.call('POST', '/v1/admin/connections', {
      body: {
        name: 'Survivor',
        adapter: 'memory',
        mode: 'read_write',
        expose: 'all',
        config: {
          collections: [
            {
              name: 'notes',
              fields: [{ name: 'id', type: 'string', primaryKey: true, required: true }],
              relations: [],
            },
          ],
        },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await first.close();
    const second = await startGateway(settings, { env });
    try {
      const back = await second.call(
        'GET',
        `/v1/admin/connections/${created.body.data.id as string}`,
      );
      assert.equal(back.status, 200);
    } finally {
      await second.close();
    }
  });
});
