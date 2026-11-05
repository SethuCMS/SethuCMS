/** Singleton collections: one record, edited in place, never deleted. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSchema } from '../src/schema/code.js';
import { demoConnection, startGateway } from './helpers.js';

const schema = { collections: [{ name: 'authors', singleton: true, title: 'Site owner' }] };

describe('singleton collections', () => {
  it('is checked in the schema file', () => {
    assert.equal(parseSchema(schema).collections[0]?.singleton, true);
    assert.throws(
      () => parseSchema({ collections: [{ name: 'a', singleton: 'yes' }] }),
      /singleton/,
    );
  });

  it('tells the admin which collections are singletons', async () => {
    const t = await startGateway({}, { schema });
    try {
      const id = await demoConnection(t);
      const one = await t.call('GET', `/v1/connections/${id}/collections/authors`);
      assert.deepEqual(one.body.data.ui, { title: 'Site owner', singleton: true });
      const other = await t.call('GET', `/v1/connections/${id}/collections/articles`);
      assert.equal(other.body.data.ui?.singleton, undefined);
    } finally {
      await t.close();
    }
  });

  it('refuses a second record, a second draft and a delete, but allows edits', async () => {
    const t = await startGateway({}, { schema });
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/authors`;

      const create = await t.call('POST', `${base}/records`, { body: { name: 'Another' } });
      assert.equal(create.status, 409);
      assert.equal(create.body.error.details.reason, 'singleton');

      const draft = await t.call('POST', `${base}/drafts`, { body: { values: { name: 'Another' } } });
      assert.equal(draft.status, 409);

      const del = await t.call('DELETE', `${base}/records/1`);
      assert.equal(del.status, 409);
      assert.equal((await t.call('GET', `${base}/records/1`)).status, 200);

      const edit = await t.call('PATCH', `${base}/records/1`, { body: { bio: 'Edited in place' } });
      assert.equal(edit.status, 200);
    } finally {
      await t.close();
    }
  });

  it('takes exactly one record when the collection is empty', async () => {
    const t = await startGateway({}, { schema });
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/authors`;
      // Empty it behind the service, as a fresh database would be.
      const bound = await t.gateway.services.registry.bind(id);
      await bound.guarded.delete('authors', '1');
      await bound.guarded.delete('authors', '2');

      const first = await t.call('POST', `${base}/records`, { body: { name: 'The one' } });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await t.call('POST', `${base}/records`, { body: { name: 'Too many' } });
      assert.equal(second.status, 409);
    } finally {
      await t.close();
    }
  });
});
