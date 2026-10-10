// The gateway as many short-lived instances on one Firestore state, against
// the in-memory fake: changes made by one instance show on the others, two
// instances saving at once lose nothing, and what needs a long-lived process
// is refused. Also the serverless settings and the request handler.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { configFromEnv } from '../src/config.js';
import { createGateway, type Gateway } from '../src/gateway.js';
import { silentLogger } from '../src/logger.js';
import { createHandler } from '../src/serverless.js';
import {
  SharedFirestoreStateStore,
  FirestoreAuditSink,
} from '../src/store/firestore.js';
import { emptyState } from '../src/store/state.js';
import { ADMIN_TOKEN, startGateway, type TestGateway } from './helpers.js';
import { FakeStateFirestore } from './fake-state-firestore.js';

const secrets = (): NodeJS.ProcessEnv => ({
  SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
  SETHUCMS_VAULT_KEY: randomBytes(32).toString('base64'),
  SETHUCMS_CURSOR_SECRET: randomBytes(32).toString('base64'),
  SETHUCMS_PREVIEW_SECRET: randomBytes(32).toString('base64'),
});

const settings = {
  seedDemo: false,
  serverless: true,
  worker: false,
  statePollMs: 0,
  firestore: { projectId: 'demo-sethucms', prefix: 'sethucms' },
};

async function instances(
  count: number,
): Promise<{ fake: FakeStateFirestore; all: TestGateway[] }> {
  const fake = new FakeStateFirestore();
  const env = secrets();
  const all: TestGateway[] = [];
  for (let i = 0; i < count; i += 1) {
    all.push(await startGateway(settings, { env, firestore: fake }));
  }
  return { fake, all };
}

const closeAll = (all: TestGateway[]): Promise<unknown> =>
  Promise.all(all.map((t) => t.close()));

describe('serverless gateway: many instances, one Firestore state', () => {
  it('a token made on one instance works on another, and revoking it stops it on both', async () => {
    const { all } = await instances(2);
    const [a, b] = all as [TestGateway, TestGateway];
    try {
      const made = await a.call('POST', '/v1/admin/tokens', {
        body: { name: 'shared', role: 'editor' },
      });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const token = made.body.data.token as string;
      const id = made.body.data.id as string;
      assert.equal(
        (await b.call('GET', '/v1/connections', { token })).status,
        200,
        'accepted on the other instance at once',
      );
      assert.equal((await b.call('DELETE', `/v1/admin/tokens/${id}`)).status, 204);
      assert.equal(
        (await a.call('GET', '/v1/connections', { token })).status,
        401,
        'revocation reaches the first instance',
      );
    } finally {
      await closeAll(all);
    }
  });

  it('two instances saving at the same time lose nothing', async () => {
    const { all } = await instances(2);
    try {
      const jobs = Array.from({ length: 12 }, (_, i) =>
        (all[i % 2] as TestGateway).call('POST', '/v1/admin/tokens', {
          body: { name: `t${i}`, role: 'viewer' },
        }),
      );
      const done = await Promise.all(jobs);
      assert.ok(done.every((r) => r.status === 201), 'every save succeeded');
      for (const t of all) {
        const list = await t.call('GET', '/v1/admin/tokens');
        const names = (list.body.data as Array<{ name: string }>).map((x) => x.name);
        for (let i = 0; i < 12; i += 1) {
          assert.ok(names.includes(`t${i}`), `t${i} is visible on every instance`);
        }
      }
    } finally {
      await closeAll(all);
    }
  });

  it('keeps a connection after every instance has been replaced', async () => {
    const fake = new FakeStateFirestore();
    const env = secrets();
    const first = await startGateway(settings, { env, firestore: fake });
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
              fields: [
                { name: 'id', type: 'string', primaryKey: true, required: true },
              ],
              relations: [],
            },
          ],
        },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await first.close();
    const second = await startGateway(settings, { env, firestore: fake });
    try {
      const back = await second.call(
        'GET',
        `/v1/admin/connections/${created.body.data.id as string}`,
      );
      assert.equal(back.status, 200);
      assert.equal(back.body.data.name, 'Survivor');
    } finally {
      await second.close();
    }
  });

  it('takes no lease, so any number can start', async () => {
    const { fake, all } = await instances(3);
    try {
      assert.equal(fake.data.get('sethucms_meta')?.has('lease') ?? false, false);
    } finally {
      await closeAll(all);
    }
  });

  it('refuses live events, the change feed and webhooks instead of losing data', async () => {
    const { all } = await instances(1);
    const [t] = all as [TestGateway];
    try {
      for (const path of ['/v1/changes', '/v1/events', '/v1/admin/webhooks']) {
        const r = await t.call('GET', path);
        assert.equal(r.status, 501, path);
        assert.equal(r.body.error.code, 'NOT_SUPPORTED');
      }
    } finally {
      await closeAll(all);
    }
  });

  it('writes the audit trail to Firestore, and flush() saves it', async () => {
    const { fake, all } = await instances(1);
    const [t] = all as [TestGateway];
    try {
      await t.call('POST', '/v1/admin/tokens', {
        body: { name: 'audited', role: 'viewer' },
      });
      await t.gateway.flush();
      const audit = fake.data.get('sethucms_audit');
      assert.ok(audit && audit.size > 0, 'audit entries are in Firestore');
    } finally {
      await closeAll(all);
    }
  });

  it('stores no token or vault key in plain text', async () => {
    const fake = new FakeStateFirestore();
    const env = secrets();
    const t = await startGateway(settings, { env, firestore: fake });
    const made = await t.call('POST', '/v1/admin/tokens', {
      body: { name: 'x', role: 'editor' },
    });
    await t.gateway.flush();
    await t.close();
    const all = JSON.stringify(
      [...fake.data.entries()].map(([k, v]) => [k, [...v.entries()]]),
    );
    assert.ok(!all.includes(made.body.data.token as string));
    assert.ok(!all.includes(ADMIN_TOKEN));
    assert.ok(!all.includes(env['SETHUCMS_VAULT_KEY'] as string));
  });
});

describe('shared Firestore state store', () => {
  it('refuses a change that would write too many records at once', async () => {
    const fake = new FakeStateFirestore();
    const store = await SharedFirestoreStateStore.open(fake, 'sethucms', {
      staleMs: 0,
    });
    await assert.rejects(
      () =>
        store.update((s) => {
          for (let i = 0; i < 500; i += 1) {
            s.tokens[`t${i}`] = {
              id: `t${i}`,
              name: 'n',
              role: 'viewer',
              hash: 'h',
              createdAt: 'now',
            };
          }
        }),
      /too many/,
    );
    assert.deepEqual(store.read().tokens, emptyState().tokens);
  });

  it('checks for changes only when its copy is older than staleMs', async () => {
    const fake = new FakeStateFirestore();
    let now = 1_000;
    const a = await SharedFirestoreStateStore.open(fake, 'sethucms', {
      staleMs: 5_000,
      now: () => now,
    });
    const b = await SharedFirestoreStateStore.open(fake, 'sethucms', {
      staleMs: 0,
      now: () => now,
    });
    await b.update((s) => {
      s.tokens['x'] = {
        id: 'x',
        name: 'x',
        role: 'viewer',
        hash: 'h',
        createdAt: 'now',
      };
    });
    await a.fresh();
    assert.equal(a.read().tokens['x'], undefined, 'recent copy is used as is');
    now += 6_000;
    await a.fresh();
    assert.ok(a.read().tokens['x'], 'an old copy is refreshed');
  });

  it('keeps the old copy when Firestore cannot be reached', async () => {
    const fake = new FakeStateFirestore();
    const store = await SharedFirestoreStateStore.open(fake, 'sethucms', {
      staleMs: 0,
    });
    const real = fake.collection.bind(fake);
    fake.collection = () => {
      throw new Error('offline');
    };
    await store.fresh();
    fake.collection = real;
    assert.ok(store.read());
  });
});

describe('serverless settings', () => {
  const base = { NODE_ENV: 'production' };

  it('needs a Firestore project', () => {
    assert.throws(
      () => configFromEnv({ ...base, SETHUCMS_SERVERLESS: '1' }),
      /SETHUCMS_FIRESTORE_PROJECT/,
    );
  });

  it('turns the worker off and defaults the check interval to one second', () => {
    const config = configFromEnv({
      ...base,
      SETHUCMS_SERVERLESS: '1',
      SETHUCMS_FIRESTORE_PROJECT: 'my-project-1',
      SETHUCMS_WORKER: 'on',
    });
    assert.equal(config.serverless, true);
    assert.equal(config.worker, false);
    assert.equal(config.statePollMs, 1000);
  });

  it('checks the interval', () => {
    assert.throws(
      () =>
        configFromEnv({
          ...base,
          SETHUCMS_SERVERLESS: '1',
          SETHUCMS_FIRESTORE_PROJECT: 'my-project-1',
          SETHUCMS_STATE_POLL_MS: '-5',
        }),
      /SETHUCMS_STATE_POLL_MS/,
    );
  });

  it('is off by default', () => {
    const config = configFromEnv({
      ...base,
      SETHUCMS_FIRESTORE_PROJECT: 'my-project-1',
    });
    assert.equal(config.serverless, undefined);
  });
});

describe('request handler', () => {
  async function serve(make: Parameters<typeof createHandler>[0]) {
    const built: Gateway[] = [];
    const handler = createHandler(async () => {
      const gateway = await make();
      built.push(gateway);
      return gateway;
    });
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      url,
      close: async () => {
        await new Promise((r) => server.close(r));
        await Promise.all(built.map((g) => g.close()));
      },
    };
  }

  it('answers requests through the gateway and keeps reusing it', async () => {
    const fake = new FakeStateFirestore();
    const env = secrets();
    let built = 0;
    const s = await serve(() => {
      built += 1;
      return createGateway({
        config: { ...configFromEnv({ NODE_ENV: 'production', SETHUCMS_SERVERLESS: '1', SETHUCMS_FIRESTORE_PROJECT: 'my-project-1' }), seedDemo: false, dataDir: undefined },
        env,
        logger: silentLogger,
        firestore: fake,
      });
    });
    try {
      const health = await fetch(`${s.url}/v1/health`);
      assert.equal(health.status, 200);
      const me = await fetch(`${s.url}/v1/me`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(me.status, 200);
      assert.equal(built, 1, 'built once per instance');
    } finally {
      await s.close();
    }
  });

  it('answers 503, not a crash, when the factory throws at once', async () => {
    const s = await serve(() => {
      throw new Error('bad settings');
    });
    try {
      const r = await fetch(`${s.url}/v1/health`);
      assert.equal(r.status, 503);
    } finally {
      await s.close();
    }
  });

  it('answers 503 when the gateway cannot start, and tries again next time', async () => {
    let calls = 0;
    const fake = new FakeStateFirestore();
    const env = secrets();
    const s = await serve(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error('Firestore is unreachable'));
      }
      return createGateway({
        config: { ...configFromEnv({ NODE_ENV: 'production', SETHUCMS_SERVERLESS: '1', SETHUCMS_FIRESTORE_PROJECT: 'my-project-1' }), seedDemo: false, dataDir: undefined },
        env,
        logger: silentLogger,
        firestore: fake,
      });
    });
    try {
      const first = await fetch(`${s.url}/v1/health`);
      assert.equal(first.status, 503);
      assert.ok(!JSON.stringify(await first.json()).includes('unreachable'));
      const second = await fetch(`${s.url}/v1/health`);
      assert.equal(second.status, 200);
    } finally {
      await s.close();
    }
  });
});

void FirestoreAuditSink;
