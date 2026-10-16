// Live events and connection admin, end to end.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_TOKEN,
  demoConnection,
  readEvents,
  startGateway,
  type TestGateway,
} from './helpers.js';

describe('live events', () => {
  let t: TestGateway;
  let id: string;
  before(async () => {
    t = await startGateway();
    id = await demoConnection(t);
  });
  after(async () => {
    await t.close();
  });

  // Events carry ids only; copying field values into the stream would leak data
  // past field permissions.
  it('announces changes made through the gateway, with ids only', async () => {
    const events = await readEvents(
      `${t.url}/v1/events`,
      { Authorization: `Bearer ${ADMIN_TOKEN}` },
      2,
      async () => {
        await t.call(
          'POST',
          `/v1/connections/${id}/collections/authors/records`,
          { body: { name: 'Eventful', bio: 'secret bio' } },
        );
      },
    );
    assert.equal(events[0]?.event, 'ready');
    assert.equal(events[1]?.event, 'record.created');
    assert.equal(events[1]?.data.collection, 'authors');
    assert.ok(!JSON.stringify(events[1]).includes('secret bio'));
  });

  // Unauthenticated streams would let anyone watch activity.
  it('requires a token', async () => {
    const r = await fetch(`${t.url}/v1/events`);
    assert.equal(r.status, 401);
  });
});

describe('connections admin', () => {
  let t: TestGateway;
  before(async () => {
    // The host resolver is stubbed so SSRF rules are tested without real DNS.
    t = await startGateway(
      { seedDemo: false },
      {
        resolveHost: async (host) =>
          host === 'db.internal.test'
            ? ['10.1.2.3']
            : host === 'meta.test'
              ? ['169.254.169.254']
              : ['93.184.216.34'],
      },
    );
  });
  after(async () => {
    await t.close();
  });

  // Each connection must have its own isolated data.
  it('keeps several connections live at once, each with its own data', async () => {
    const a = await t.call('POST', '/v1/admin/connections', {
      body: {
        name: 'Shop',
        adapter: 'memory',
        mode: 'read_write',
        expose: 'all',
      },
    });
    const b = await t.call('POST', '/v1/admin/connections', {
      body: {
        name: 'Blog',
        adapter: 'memory',
        mode: 'read_write',
        expose: 'all',
      },
    });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    await t.call(
      'POST',
      `/v1/connections/${a.body.data.id}/collections/authors/records`,
      { body: { name: 'Only in shop' } },
    );
    const inA = await t.call(
      'GET',
      `/v1/connections/${a.body.data.id}/collections/authors/records`,
    );
    const inB = await t.call(
      'GET',
      `/v1/connections/${b.body.data.id}/collections/authors/records`,
    );
    assert.equal(inA.body.data.length, 1);
    assert.equal(inB.body.data.length, 0);
  });

  // New collections stay hidden until an admin reviews them, so a new table
  // never becomes public by accident.
  it('hides new collections until an admin reviews them', async () => {
    const created = await t.call('POST', '/v1/admin/connections', {
      body: { name: 'Careful', adapter: 'memory', mode: 'read_write' },
    });
    const id = created.body.data.id;
    assert.equal(
      (await t.call('GET', `/v1/connections/${id}/collections`)).body.data
        .length,
      0,
    );
    assert.equal(
      (await t.call('GET', `/v1/connections/${id}/collections/authors/records`))
        .status,
      404,
    );

    const overview = await t.call('GET', '/v1/admin/overview');
    assert.ok(
      overview.body.reviewQueue.some(
        (item: any) =>
          item.connectionId === id && item.collection === 'authors',
      ),
    );

    await t.call('PUT', `/v1/admin/connections/${id}/collections/authors`, {
      body: { exposed: true },
    });
    assert.equal(
      (await t.call('GET', `/v1/connections/${id}/collections/authors/records`))
        .status,
      200,
    );
    // articles references authors: hiding authors again must not break the model
    await t.call('PUT', `/v1/admin/connections/${id}/collections/articles`, {
      body: { exposed: true },
    });
    await t.call('PUT', `/v1/admin/connections/${id}/collections/authors`, {
      body: { exposed: false },
    });
    assert.equal(
      (
        await t.call(
          'GET',
          `/v1/connections/${id}/collections/articles/records`,
        )
      ).status,
      200,
    );
  });

  // Secrets must go in credentials (encrypted), never in plain config, and must
  // not be echoed back in the error.
  it('refuses secrets in config and unknown adapters', async () => {
    const secret = await t.call('POST', '/v1/admin/connections', {
      body: {
        name: 'x',
        adapter: 'postgres',
        config: { host: 'h', password: 'hunter2' },
      },
    });
    assert.equal(secret.status, 400);
    assert.ok(!JSON.stringify(secret.body).includes('hunter2'));
    assert.equal(
      (
        await t.call('POST', '/v1/admin/connections', {
          body: { name: 'x', adapter: 'oracle9000' },
        })
      ).status,
      400,
    );
  });

  // SSRF protection - metadata addresses are always blocked, private ranges
  // when disallowed.
  it('blocks the cloud metadata address and, when configured, private networks', async () => {
    const metadata = await t.call('POST', '/v1/admin/connections', {
      body: {
        name: 'bad',
        adapter: 'postgres',
        config: { host: 'meta.test', database: 'd' },
        credentials: { user: 'u', password: 'p' },
      },
    });
    assert.equal(metadata.status, 400);
    assert.match(metadata.body.error.message, /not allowed/);

    const strict = await startGateway(
      { seedDemo: false, allowPrivateNetworks: false },
      { resolveHost: async () => ['10.1.2.3'] },
    );
    try {
      const r = await strict.call('POST', '/v1/admin/connections', {
        body: {
          name: 'internal',
          adapter: 'postgres',
          config: { host: 'db.internal.test', database: 'd' },
          credentials: { user: 'u', password: 'p' },
        },
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, /Private network/);
    } finally {
      await strict.close();
    }
  });

  // Connection failures must give a helpful message without leaking credentials
  // or raw network errors.
  it('reports a clear, safe message when a database is unreachable', async () => {
    const r = await t.call('POST', '/v1/admin/connections', {
      body: {
        name: 'down',
        adapter: 'postgres',
        config: { host: '127.0.0.1', port: 1, database: 'd', ssl: false },
        credentials: { user: 'u', password: 'super-secret-pw' },
      },
    });
    assert.ok(r.status === 502 || r.status === 400, `status ${r.status}`);
    assert.ok(!JSON.stringify(r.body).includes('super-secret-pw'));
    assert.ok(!JSON.stringify(r.body).includes('ECONNREFUSED'));
  });

  // The audit log is useful only if it records operations without storing
  // secrets.
  it('records changes in the audit log without secrets', async () => {
    const audit = await t.call('GET', '/v1/admin/audit?limit=100');
    const text = JSON.stringify(audit.body);
    assert.ok(
      audit.body.data.some((e: any) => e.operation === 'connection.create'),
    );
    assert.ok(!text.includes('hunter2'));
    assert.ok(!text.includes('super-secret-pw'));
  });
});
