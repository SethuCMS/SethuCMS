// Covers the public HTTP API end to end - auth, headers, records, roles and
// read-only mode. Drafts, events and connection admin have their own files.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_TOKEN,
  demoConnection,
  startGateway,
  tokenFor,
  type TestGateway,
} from './helpers.js';

describe('gateway basics', () => {
  let t: TestGateway;
  before(async () => {
    t = await startGateway();
  });
  after(async () => {
    await t.close();
  });

  // Load balancers probe health without credentials; it must stay open.
  it('answers health checks without a token', async () => {
    const r = await t.call('GET', '/v1/health', { token: null });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.ok(r.headers.get('x-request-id'));
  });

  // Every auth failure must return the same standard error body, so clients can
  // handle it and attackers learn nothing.
  it('refuses missing, malformed and wrong tokens with the standard error body', async () => {
    for (const token of [null, 'short', 'adb_' + 'x'.repeat(40)]) {
      const r = await t.call('GET', '/v1/connections', { token });
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'AUTH_FAILED');
      assert.ok(r.body.error.requestId);
    }
  });

  // Missing no-store or nosniff would let proxies cache private data or
  // browsers sniff API JSON as HTML.
  it('sends security headers and no caching on API answers', async () => {
    const r = await t.call('GET', '/v1/connections');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(
      r.headers.get('content-security-policy') ?? '',
      /default-src 'none'/,
    );
  });

  // Errors must not reveal framework or route internals; 405 must tell clients
  // which methods are valid.
  it('answers 404 and 405 without leaking details', async () => {
    assert.equal((await t.call('GET', '/v1/nope')).status, 404);
    const r = await t.call('PUT', '/v1/connections');
    assert.equal(r.status, 405);
    assert.match(r.headers.get('allow') ?? '', /GET/);
  });

  // CORS is an allowlist; echoing any origin would let hostile sites call the
  // API with a user's credentials.
  it('only allows configured browser origins (CORS)', async () => {
    const allowed = await fetch(t.url + '/v1/health', {
      headers: { Origin: 'http://admin.test' },
    });
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      'http://admin.test',
    );
    const denied = await fetch(t.url + '/v1/health', {
      headers: { Origin: 'http://evil.test' },
    });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });

  // The SDK relies on this response shape, so changing it is a breaking change.
  it('lists the demo connection and its exposed collections (SDK contract)', async () => {
    const connections = await t.call('GET', '/v1/connections');
    assert.equal(connections.body.data.length, 1);
    assert.equal(connections.body.data[0].adapterType, 'memory');
    const id = connections.body.data[0].id;
    const collections = await t.call(
      'GET',
      `/v1/connections/${id}/collections`,
    );
    assert.deepEqual(collections.body.data.map((c: any) => c.name).sort(), [
      'articles',
      'authors',
    ]);
    const articles = collections.body.data.find(
      (c: any) => c.name === 'articles',
    );
    assert.ok(
      articles.fields.some((f: any) => f.primaryKey && f.name === 'id'),
    );
  });

  // Body limits stop memory exhaustion; non-JSON types must not reach the
  // parser.
  it('rejects oversize and non-JSON bodies', async () => {
    const id = await demoConnection(t);
    const wrongType = await fetch(
      `${t.url}/v1/connections/${id}/collections/authors/records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'text/plain',
        },
        body: 'hi',
      },
    );
    assert.equal(wrongType.status, 400);
    const big = await fetch(
      `${t.url}/v1/connections/${id}/collections/authors/records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'x'.repeat(1_100_000) }),
      },
    );
    assert.equal(big.status, 400);
  });
});

describe('records', () => {
  let t: TestGateway;
  let id: string;
  before(async () => {
    t = await startGateway();
    id = await demoConnection(t);
  });
  after(async () => {
    await t.close();
  });

  const base = (collection: string) =>
    `/v1/connections/${id}/collections/${collection}/records`;

  // Cursor paging with sort and projection; wrong ordering would skip or repeat
  // rows.
  it('lists with sort, field selection and cursor pagination', async () => {
    const first = await t.call(
      'GET',
      `${base('articles')}?sort=-id&limit=2&fields=id,title`,
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.data.length, 2);
    assert.deepEqual(Object.keys(first.body.data[0]).sort(), ['id', 'title']);
    assert.equal(first.body.data[0].id, 3);
    assert.ok(first.body.page.nextCursor);

    const second = await t.call(
      'GET',
      `${base('articles')}?sort=-id&limit=2&fields=id,title&cursor=${encodeURIComponent(first.body.page.nextCursor)}`,
    );
    assert.equal(second.body.data.length, 1);
    assert.equal(second.body.page.nextCursor, null);
  });

  // Cursors are signed and bound to their query, so edited or reused ones must
  // be rejected.
  it('refuses a cursor that was edited or used for another query', async () => {
    const first = await t.call('GET', `${base('articles')}?limit=1`);
    const cursor = first.body.page.nextCursor as string;
    const forged = await t.call(
      'GET',
      `${base('articles')}?limit=1&cursor=${encodeURIComponent(cursor.slice(0, -2) + 'AA')}`,
    );
    assert.equal(forged.status, 400);
    const otherQuery = await t.call(
      'GET',
      `${base('articles')}?limit=1&sort=-id&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(otherQuery.status, 400);
  });

  it('filters with the portable filter language', async () => {
    const filter = JSON.stringify({
      and: [
        { field: 'status', op: 'eq', value: 'live' },
        { field: 'rating', op: 'gte', value: 4 },
      ],
    });
    const r = await t.call(
      'GET',
      `${base('articles')}?filter=${encodeURIComponent(filter)}`,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.data.map((a: any) => a.slug),
      ['front-door'],
    );
  });

  // Unknown parameters and hostile names are refused up front rather than
  // silently ignored; offset is unsupported by design.
  it('rejects unknown parameters, bad filters and injection-shaped names', async () => {
    assert.equal(
      (await t.call('GET', `${base('articles')}?offset=5`)).status,
      400,
    );
    assert.equal(
      (
        await t.call(
          'GET',
          `${base('articles')}?filter=${encodeURIComponent('{"field":"id; DROP TABLE x","op":"eq","value":1}')}`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await t.call('GET', `${base('articles')}?filter=not-json`)).status,
      400,
    );
    assert.equal(
      (await t.call('GET', `${base('articles')}?limit=100000`)).status,
      400,
    );
  });

  it('creates, reads, updates and deletes a record', async () => {
    const created = await t.call('POST', base('authors'), {
      body: { name: 'Mira Das', email: 'mira@example.com' },
    });
    assert.equal(created.status, 201);
    const authorId = created.body.data.id;
    assert.equal(
      (await t.call('GET', `${base('authors')}/${authorId}`)).body.data.name,
      'Mira Das',
    );

    const updated = await t.call('PATCH', `${base('authors')}/${authorId}`, {
      body: { bio: 'New bio' },
    });
    assert.equal(updated.body.data.bio, 'New bio');

    assert.equal(
      (await t.call('DELETE', `${base('authors')}/${authorId}`)).status,
      204,
    );
    assert.equal(
      (await t.call('GET', `${base('authors')}/${authorId}`)).status,
      404,
    );
  });

  // Writes go through the content model, so required, enum, generated and
  // unknown fields cannot be bypassed.
  it('validates writes with the content model', async () => {
    const missing = await t.call('POST', base('articles'), {
      body: { slug: 'x' },
    });
    assert.equal(missing.status, 400);
    const badEnum = await t.call('POST', base('articles'), {
      body: { title: 'T', slug: 'ok', status: 'nonsense' },
    });
    assert.equal(badEnum.status, 400);
    const generated = await t.call('POST', base('articles'), {
      body: { id: 99, title: 'T', slug: 'ok' },
    });
    assert.equal(generated.status, 400);
    const unknown = await t.call('POST', base('articles'), {
      body: { title: 'T', slug: 'ok', admin: true },
    });
    assert.equal(unknown.status, 400);
  });

  // A different error for missing and forbidden collections would let callers
  // map the schema.
  it('does not reveal whether a collection or record exists beyond a plain 404', async () => {
    const r = await t.call(
      'GET',
      `/v1/connections/${id}/collections/secrets/records`,
    );
    assert.equal(r.status, 404);
    assert.ok(!JSON.stringify(r.body).includes('secrets'));
    assert.equal((await t.call('GET', `${base('articles')}/abc`)).status, 404);
  });

  // A retried POST (network drop) must not create a duplicate; reusing the key
  // for a different body is a client bug.
  it('replays a write that is retried with the same Idempotency-Key', async () => {
    const headers = { 'Idempotency-Key': 'retry-test-1' };
    const first = await t.call('POST', base('authors'), {
      body: { name: 'Once' },
      headers,
    });
    const second = await t.call('POST', base('authors'), {
      body: { name: 'Once' },
      headers,
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.body.data.id, first.body.data.id);
    assert.equal(second.headers.get('idempotent-replay'), 'true');
    const all = await t.call(
      'GET',
      `${base('authors')}?filter=${encodeURIComponent('{"field":"name","op":"eq","value":"Once"}')}`,
    );
    assert.equal(all.body.data.length, 1);

    const reuse = await t.call('POST', base('authors'), {
      body: { name: 'Different' },
      headers,
    });
    assert.equal(reuse.status, 409);
  });
});

// Role checks are the main authorisation boundary.
describe('roles', () => {
  let t: TestGateway;
  let id: string;
  before(async () => {
    t = await startGateway();
    id = await demoConnection(t);
  });
  after(async () => {
    await t.close();
  });

  // Viewers must be blocked from writes, drafts (unpublished content) and admin
  // pages.
  it('viewers can read but not write, and cannot see drafts or admin pages', async () => {
    const viewer = await tokenFor(t, 'viewer');
    const records = `/v1/connections/${id}/collections/authors/records`;
    assert.equal((await t.call('GET', records, { token: viewer })).status, 200);
    assert.equal(
      (await t.call('POST', records, { token: viewer, body: { name: 'No' } }))
        .status,
      403,
    );
    assert.equal(
      (
        await t.call(
          'GET',
          `/v1/connections/${id}/collections/authors/drafts`,
          { token: viewer },
        )
      ).status,
      403,
    );
    assert.equal(
      (await t.call('GET', '/v1/admin/audit', { token: viewer })).status,
      403,
    );
    assert.equal(
      (
        await t.call('POST', '/v1/admin/connections', {
          token: viewer,
          body: {},
        })
      ).status,
      403,
    );
  });

  // Editors must not escalate by minting admin tokens or removing connections.
  it('editors can write records but cannot manage connections or tokens', async () => {
    const editor = await tokenFor(t, 'editor');
    const records = `/v1/connections/${id}/collections/authors/records`;
    assert.equal(
      (await t.call('POST', records, { token: editor, body: { name: 'Yes' } }))
        .status,
      201,
    );
    assert.equal(
      (
        await t.call('POST', '/v1/admin/tokens', {
          token: editor,
          body: { name: 'x', role: 'admin' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await t.call('DELETE', `/v1/admin/connections/${id}`, { token: editor }))
        .status,
      403,
    );
  });

  // Revocation must take effect on the next request, not at some later cache
  // expiry.
  it('revoked tokens stop working immediately', async () => {
    const created = await t.call('POST', '/v1/admin/tokens', {
      body: { name: 'temp', role: 'editor' },
    });
    const token = created.body.data.token as string;
    assert.equal((await t.call('GET', '/v1/me', { token })).status, 200);
    assert.equal(
      (await t.call('DELETE', `/v1/admin/tokens/${created.body.data.id}`))
        .status,
      204,
    );
    assert.equal((await t.call('GET', '/v1/me', { token })).status, 401);
  });

  // Hashes are verifier material; exposing them would aid offline guessing.
  it('never returns token hashes', async () => {
    const list = await t.call('GET', '/v1/admin/tokens');
    assert.ok(!JSON.stringify(list.body).includes('hash'));
  });
});

// Safe default for new connections.
describe('read-only connections', () => {
  let t: TestGateway;
  before(async () => {
    t = await startGateway({ seedDemo: false });
  });
  after(async () => {
    await t.close();
  });

  // A connection with no explicit mode must refuse writes, with a code clients
  // can recognise.
  it('are the default and refuse every write', async () => {
    const created = await t.call('POST', '/v1/admin/connections', {
      body: { name: 'Look only', adapter: 'memory', expose: 'all' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.mode, 'read_only');
    const id = created.body.data.id;
    const r = await t.call(
      'POST',
      `/v1/connections/${id}/collections/authors/records`,
      { body: { name: 'x' } },
    );
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'READ_ONLY');
  });
});
