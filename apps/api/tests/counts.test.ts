/** Record counts: exact, capped, and never more than a list would show. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { demoConnection, startGateway, tokenFor } from './helpers.js';

describe('record counts', () => {
  it('counts exactly, honours a filter, and caps with exact=false', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const list = await t.call('GET', `/v1/connections/${id}/collections/articles/records?limit=500`);
      const total = list.body.data.length as number;
      assert.ok(total >= 3, 'demo data should have a few articles');

      const all = await t.call('GET', `/v1/connections/${id}/collections/articles/count`);
      assert.equal(all.status, 200);
      assert.deepEqual(all.body.data, { count: total, exact: true });

      const capped = await t.call('GET', `/v1/connections/${id}/collections/articles/count?max=2`);
      assert.deepEqual(capped.body.data, { count: 2, exact: false });

      const filter = encodeURIComponent(JSON.stringify({ field: 'id', op: 'eq', value: list.body.data[0].id }));
      const one = await t.call('GET', `/v1/connections/${id}/collections/articles/count?filter=${filter}`);
      assert.equal(one.status, 200, JSON.stringify(one.body));
      assert.deepEqual(one.body.data, { count: 1, exact: true });
    } finally {
      await t.close();
    }
  });

  it('refuses bad input and unknown parameters', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/articles/count`;
      assert.equal((await t.call('GET', `${base}?max=abc`)).status, 400);
      assert.equal((await t.call('GET', `${base}?max=0`)).status, 400);
      assert.equal((await t.call('GET', `${base}?max=99999`)).status, 400);
      assert.equal((await t.call('GET', `${base}?sort=id`)).status, 400);
      assert.equal((await t.call('GET', `${base}?filter=not-json`)).status, 400);
      assert.equal((await t.call('GET', base, { token: null })).status, 401);
      assert.equal((await t.call('GET', `/v1/connections/${id}/collections/nope/count`)).status, 404);
    } finally {
      await t.close();
    }
  });

  it('forgets a remembered count when a record is added or removed', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/articles`;
      const before = (await t.call('GET', `${base}/count`)).body.data.count as number;
      const created = await t.call('POST', `${base}/records`, { body: { title: 'Counted', slug: 'counted' } });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal((await t.call('GET', `${base}/count`)).body.data.count, before + 1);
      const newId = created.body.data.id;
      assert.equal((await t.call('DELETE', `${base}/records/${newId}`)).status, 204);
      assert.equal((await t.call('GET', `${base}/count`)).body.data.count, before);
    } finally {
      await t.close();
    }
  });

  it('gives a sidebar answer for every collection the caller can read', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const counts = await t.call('GET', `/v1/connections/${id}/counts`);
      assert.equal(counts.status, 200);
      assert.equal(counts.body.data.articles.exact, true);
      const viewer = await tokenFor(t, 'viewer');
      const asViewer = await t.call('GET', `/v1/connections/${id}/counts`, { token: viewer });
      assert.equal(asViewer.status, 200);
      assert.ok(typeof asViewer.body.data.articles.count === 'number');
    } finally {
      await t.close();
    }
  });
});
