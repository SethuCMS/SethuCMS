// Covers the public HTTP API end to end - auth, headers, records, roles, read-
// only mode, drafts and previews, live events and connection admin.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_TOKEN,
  demoConnection,
  readEvents,
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

describe('drafts, publish and preview', () => {
  let t: TestGateway;
  let id: string;
  before(async () => {
    t = await startGateway();
    id = await demoConnection(t);
  });
  after(async () => {
    await t.close();
  });

  const drafts = () => `/v1/connections/${id}/collections/articles/drafts`;
  const records = () => `/v1/connections/${id}/collections/articles/records`;

  // Edits live in the draft only; the public record must not change before
  // publish.
  it('keeps edits out of the database until published', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 3, values: { title: 'Live preview, v2' } },
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.data.version, 1);

    const published = await t.call('GET', `${records()}/3`);
    assert.equal(published.body.data.title, 'A tour of live preview');

    const saved = await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { body: 'Edited body' } },
    });
    assert.equal(saved.body.data.version, 2);
    assert.equal(saved.body.data.values.title, 'Live preview, v2');
    assert.equal(
      (await t.call('GET', `${records()}/3`)).body.data.body,
      'Change a word and watch the page update.',
    );

    const result = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
      { body: { version: 2 } },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.data.record.title, 'Live preview, v2');
    assert.equal(
      (await t.call('GET', `${records()}/3`)).body.data.body,
      'Edited body',
    );
    assert.equal(result.body.data.draft.status, 'published');

    const again = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(again.status, 409);
  });

  // Drafts can be partial; completeness is enforced when publishing, not when
  // saving.
  it('creates new records from drafts and checks completeness only on publish', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { values: { title: 'Half finished' } },
    });
    assert.equal(draft.status, 201);
    const early = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(early.status, 400); // slug is required
    const fixed = await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { slug: 'half-finished' } },
    });
    assert.equal(fixed.status, 200);
    const done = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(done.status, 200);
    assert.ok(done.body.data.record.id);
  });

  // Optimistic locking - a stale save must not overwrite a newer one, and the
  // current version is returned so the client can recover.
  it('refuses a save based on an old version', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { rating: 4 } },
    });
    await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { rating: 3 } },
    });
    const stale = await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { rating: 2 } },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.details.currentVersion, 2);
  });

  // Publishing over a record changed in the meantime would silently lose that
  // edit; the editor must choose via force.
  it('refuses to publish over a record that changed meanwhile, unless forced', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 2, values: { title: 'My edit' } },
    });
    await t.call('PATCH', `${records()}/2`, { body: { rating: 1 } }); // someone else edits the live record
    const blocked = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.details.reason, 'record_changed');
    // The draft is still open so the editor can decide.
    const open = await t.call('GET', `${drafts()}/${draft.body.data.id}`);
    assert.equal(open.body.data.status, 'draft');
    const forced = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
      { body: { force: true } },
    );
    assert.equal(forced.status, 200);
    assert.equal(forced.body.data.record.title, 'My edit');
  });

  // Drafts must be held to the same rules as direct writes, or they would be a
  // validation bypass.
  it('validates draft values like record values', async () => {
    assert.equal(
      (await t.call('POST', drafts(), { body: { values: { rating: 99 } } }))
        .status,
      400,
    );
    assert.equal(
      (await t.call('POST', drafts(), { body: { values: { id: 5 } } })).status,
      400,
    );
    assert.equal(
      (await t.call('POST', drafts(), { body: { values: { nope: 1 } } }))
        .status,
      400,
    );
    assert.equal(
      (await t.call('POST', drafts(), { body: { recordId: 9999, values: {} } }))
        .status,
      404,
    );
  });

  // Discarding must leave no trace in the published data.
  it('discarding a draft leaves the record alone', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'Throwaway' } },
    });
    assert.equal(
      (await t.call('DELETE', `${drafts()}/${draft.body.data.id}`)).status,
      204,
    );
    assert.notEqual(
      (await t.call('GET', `${records()}/1`)).body.data.title,
      'Throwaway',
    );
    const open = await t.call('GET', drafts());
    assert.ok(!open.body.data.some((d: any) => d.id === draft.body.data.id));
  });

  // A draft id must only resolve under its own collection, or collection-level
  // permissions could be sidestepped.
  it('drafts cannot be reached through a different collection', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'X' } },
    });
    const wrong = await t.call(
      'GET',
      `/v1/connections/${id}/collections/authors/drafts/${draft.body.data.id}`,
    );
    assert.equal(wrong.status, 404);
  });

  // Preview links are bearer credentials for unpublished content, so they must
  // work without a token yet reject forgeries and be kept out of search
  // indexes.
  it('shows a draft through a preview link without an API token', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'Preview me' } },
    });
    const link = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/preview-link`,
    );
    assert.equal(link.status, 201);

    const view = await t.call('GET', link.body.data.path, { token: null });
    assert.equal(view.status, 200);
    assert.equal(view.body.data.title, 'Preview me');
    assert.equal(view.body.data.slug, 'front-door'); // untouched fields come from the published record
    assert.equal(view.headers.get('x-robots-tag'), 'noindex');

    const forged = link.body.data.token.replace(/.$/, (c: string) =>
      c === 'A' ? 'B' : 'A',
    );
    assert.equal(
      (await t.call('GET', `/v1/preview/${forged}`, { token: null })).status,
      401,
    );
    assert.equal(
      (await t.call('GET', '/v1/preview/garbage', { token: null })).status,
      401,
    );
  });

  // A preview link must not outlive the access of the person who made it.
  it('stops preview links when the person who made them loses access', async () => {
    const created = await t.call('POST', '/v1/admin/tokens', {
      body: { name: 'short-lived', role: 'editor' },
    });
    const draft = await t.call('POST', drafts(), {
      token: created.body.data.token,
      body: { recordId: 1, values: { title: 'Soon gone' } },
    });
    const link = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/preview-link`,
      { token: created.body.data.token },
    );
    assert.equal(
      (await t.call('GET', link.body.data.path, { token: null })).status,
      200,
    );
    await t.call('DELETE', `/v1/admin/tokens/${created.body.data.id}`);
    assert.equal(
      (await t.call('GET', link.body.data.path, { token: null })).status,
      401,
    );
  });

  // Live preview depends on pushing draft changes over SSE; the first event is
  // the current state, then updates.
  it('pushes draft changes to an open preview (live preview)', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'First' } },
    });
    const link = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/preview-link`,
    );
    const events = await readEvents(
      t.url + link.body.data.path + '/events',
      {},
      2,
      async () => {
        await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
          body: { version: 1, values: { title: 'Second' } },
        });
      },
    );
    assert.equal(events[0]?.event, 'draft');
    assert.equal(events[0]?.data.data.title, 'First');
    assert.equal(events[1]?.event, 'draft.updated');
    assert.equal(events[1]?.data.data.title, 'Second');
  });
});

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
