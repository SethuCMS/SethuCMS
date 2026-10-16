// Declaring a new, empty collection from the admin: the Firestore-style flow
// where the database makes a collection with its first record. A small
// in-memory adapter that saves definitions stands in for Firestore, so the
// whole gateway path is exercised: validation, read-only mode, roles, the audit
// trail, writing the first record, and a second instance catching up.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { MemoryAdapter } from '@sethucms/adapter-memory';
import { errors, type CollectionDefinition } from '@sethucms/core';
import type { AdapterKind } from '../src/connections/adapters.js';
import { startGateway, tokenFor, type TestGateway } from './helpers.js';

// Behaves like the Firestore adapter: nothing exists until a definition is
// saved, and the saved definitions survive reconnecting.
class DeclaringAdapter extends MemoryAdapter {
  constructor(private readonly saved: CollectionDefinition[]) {
    super({ collections: saved });
  }
  override async introspect(): Promise<CollectionDefinition[]> {
    return [...this.saved];
  }
  async createCollection(collection: CollectionDefinition): Promise<void> {
    if (this.saved.some((found) => found.name === collection.name)) {
      throw errors.conflict('A collection with this name already exists');
    }
    this.saved.push(collection);
    (this as unknown as { tables: Map<string, unknown> }).tables.set(
      collection.name,
      { rows: new Map(), nextId: 1 },
    );
  }
}

describe('create a collection from the admin', () => {
  let t: TestGateway;
  let saved: CollectionDefinition[];
  let id: string;
  let readOnlyId: string;
  let sqlLikeId: string;

  before(async () => {
    saved = [];
    const schemaless: AdapterKind = {
      label: 'Schemaless (test)',
      create: () => new DeclaringAdapter(saved),
      networkHost: () => null,
      declareCollections: { keyField: 'id' },
    };
    // A second type that does NOT allow declaring collections, like SQL.
    const sqlLike: AdapterKind = {
      label: 'SQL-like (test)',
      create: () => new DeclaringAdapter([]),
      networkHost: () => null,
    };
    t = await startGateway(
      { seedDemo: false },
      { adapters: { schemaless, sqllike: sqlLike } },
    );
    const make = async (adapter: string, mode: string) => {
      const created = await t.call('POST', '/v1/admin/connections', {
        body: { name: `${adapter} ${mode}`, adapter, mode, config: {} },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body.data.id as string;
    };
    id = await make('schemaless', 'read_write');
    readOnlyId = await make('schemaless', 'read_only');
    sqlLikeId = await make('sqllike', 'read_write');
  });
  after(async () => {
    await t.close();
  });

  const create = (connection: string, body: unknown, token?: string) =>
    t.call('POST', `/v1/admin/connections/${connection}/collections`, {
      body,
      ...(token ? { token } : {}),
    });

  it('starts with no collections and offers to create one', async () => {
    const detail = await t.call('GET', `/v1/admin/connections/${id}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(detail.body.data.collections, []);
    assert.equal(detail.body.data.canCreateCollections, true);
    // Not offered on a read-only connection or on a SQL-like database.
    const ro = await t.call('GET', `/v1/admin/connections/${readOnlyId}`);
    assert.equal(ro.body.data.canCreateCollections, false);
    const sql = await t.call('GET', `/v1/admin/connections/${sqlLikeId}`);
    assert.equal(sql.body.data.canCreateCollections, false);
  });

  it('creates an empty collection, exposes it, and records it in the audit log', async () => {
    const made = await create(id, { name: 'projects' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const found = made.body.data.collections.find(
      (c: { name: string }) => c.name === 'projects',
    );
    assert.ok(found, 'the collection is listed');
    assert.equal(found.exposed, true);
    assert.equal(found.reviewed, true);
    assert.equal(found.primaryKey, 'id');

    const audit = await t.call('GET', '/v1/admin/audit');
    assert.ok(
      JSON.stringify(audit.body).includes('collection.create'),
      'the audit log names the action',
    );
  });

  it('lets the first record be written and read back through the content API', async () => {
    const editor = await tokenFor(t, 'editor');
    const base = `/v1/connections/${id}/collections/projects/records`;
    const empty = await t.call('GET', base, { token: editor });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data, []);

    const first = await t.call('POST', base, {
      token: editor,
      body: {},
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const list = await t.call('GET', base, { token: editor });
    assert.equal(list.body.data.length, 1);
  });

  it('keeps typed fields and enforces required ones', async () => {
    const made = await create(id, {
      name: 'posts',
      fields: [
        { name: 'title', type: 'string', required: true },
        { name: 'views', type: 'integer' },
      ],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const found = made.body.data.collections.find(
      (c: { name: string }) => c.name === 'posts',
    );
    assert.equal(found.fields, 3, 'the key plus two fields');

    const editor = await tokenFor(t, 'editor');
    const base = `/v1/connections/${id}/collections/posts/records`;
    const missing = await t.call('POST', base, {
      token: editor,
      body: { views: 3 },
    });
    assert.equal(missing.status, 400, 'title is required');
    const ok = await t.call('POST', base, {
      token: editor,
      body: { title: 'Hello', views: 3 },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
  });

  it('can create a collection without exposing it', async () => {
    const made = await create(id, { name: 'private_notes', expose: false });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const found = made.body.data.collections.find(
      (c: { name: string }) => c.name === 'private_notes',
    );
    assert.equal(found.exposed, false);
    const editor = await tokenFor(t, 'editor');
    const read = await t.call(
      'GET',
      `/v1/connections/${id}/collections/private_notes/records`,
      { token: editor },
    );
    assert.equal(read.status, 404, 'hidden collections stay hidden');
  });

  it('refuses a name that is taken', async () => {
    const again = await create(id, { name: 'projects' });
    assert.equal(again.status, 409);
  });

  it('refuses bad names and creates nothing', async () => {
    const before = saved.length;
    for (const name of [
      '',
      ' ',
      '1abc',
      '../x',
      'a/b',
      'a b',
      '_sethucms_schemas',
      '_hidden',
      '__proto__',
      'constructor',
      'x'.repeat(64),
      42,
      null,
      ['projects'],
    ]) {
      const bad = await create(id, { name });
      assert.equal(bad.status, 400, `name ${JSON.stringify(name)}`);
    }
    const missing = await create(id, {});
    assert.equal(missing.status, 400);
    assert.equal(saved.length, before, 'nothing was saved');
  });

  it('refuses bad fields and unknown settings', async () => {
    const cases: unknown[] = [
      { name: 'a1', fields: 'title' },
      { name: 'a2', fields: [{ name: 'x', type: 'nope' }] },
      { name: 'a3', fields: [{ name: 'x', type: 'reference' }] },
      { name: 'a4', fields: [{ name: 'x' }] },
      { name: 'a5', fields: [{ name: 'bad name', type: 'string' }] },
      { name: 'a6', fields: [{ name: 'id', type: 'string' }] },
      {
        name: 'a7',
        fields: [
          { name: 'x', type: 'string' },
          { name: 'x', type: 'string' },
        ],
      },
      { name: 'a8', fields: [{ name: 'x', type: 'string', primaryKey: true }] },
      { name: 'a9', nativeName: 'other' },
      { name: 'a10', expose: 'yes' },
      {
        name: 'a11',
        fields: Array.from({ length: 101 }, (_, i) => ({
          name: `f${i}`,
          type: 'string',
        })),
      },
    ];
    const before = saved.length;
    for (const body of cases) {
      const bad = await create(id, body);
      assert.equal(bad.status, 400, JSON.stringify(body).slice(0, 80));
    }
    assert.equal(saved.length, before, 'nothing was saved');
  });

  it('is refused on a read-only connection and on a SQL-like database', async () => {
    const ro = await create(readOnlyId, { name: 'nope' });
    assert.equal(ro.status, 403);
    assert.equal(ro.body.error.code, 'READ_ONLY');
    const sql = await create(sqlLikeId, { name: 'nope' });
    assert.equal(sql.status, 422);
    assert.equal(sql.body.error.code, 'CAPABILITY_UNSUPPORTED');
  });

  it('is admin only', async () => {
    const editor = await tokenFor(t, 'editor');
    const viewer = await tokenFor(t, 'viewer');
    assert.equal((await create(id, { name: 'sneaky' }, editor)).status, 403);
    assert.equal((await create(id, { name: 'sneaky' }, viewer)).status, 403);
    const anonymous = await t.call(
      'POST',
      `/v1/admin/connections/${id}/collections`,
      { token: null, body: { name: 'sneaky' } },
    );
    assert.equal(anonymous.status, 401);
    assert.ok(!saved.some((c) => c.name === 'sneaky'));
  });

  it('answers an unknown connection with not found', async () => {
    const r = await create('conn_missing', { name: 'x1' });
    assert.equal(r.status, 404);
  });

  it('lets a second gateway instance catch up on a collection made elsewhere', async () => {
    // A connection this instance has opened but not changed.
    const fresh = await t.call('POST', '/v1/admin/connections', {
      body: {
        name: 'seen by this instance',
        adapter: 'schemaless',
        mode: 'read_write',
        config: {},
      },
    });
    const freshId = fresh.body.data.id as string;
    const opened = await t.call('GET', `/v1/admin/connections/${freshId}`);
    assert.equal(opened.status, 200);

    // Another instance declared "events": it is in the database and exposed in
    // the shared settings, but this instance has not looked again yet. Going
    // straight to the adapter leaves the registry's own list stale.
    const { adapter } = await t.gateway.services.registry.raw(freshId);
    await adapter.createCollection!({
      name: 'events',
      fields: [
        {
          name: 'id',
          type: 'string',
          primaryKey: true,
          generated: true,
          required: false,
          lossy: false,
        },
      ],
      relations: [],
    });
    await t.gateway.services.store.update((state) => {
      const stored = state.connections[freshId];
      assert.ok(stored);
      stored.exposed = [...stored.exposed, 'events'];
      stored.known = [...stored.known, 'events'];
    });

    const editor = await tokenFor(t, 'editor');
    const read = await t.call(
      'GET',
      `/v1/connections/${freshId}/collections/events/records`,
      { token: editor },
    );
    assert.equal(read.status, 200, JSON.stringify(read.body));
  });
});
