/** CORS origins added from the admin panel work next to the environment list. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startGateway, type TestGateway } from './helpers.js';

describe('CORS origins from the admin panel', () => {
  let gateway: TestGateway;
  before(async () => {
    gateway = await startGateway();
  });
  after(async () => {
    await gateway?.close();
  });

  const allowed = async (origin: string) =>
    (await gateway.call('GET', '/v1/health/live', { token: null, headers: { Origin: origin } }))
      .headers.get('access-control-allow-origin');

  it('allows an added origin at once and stops when it is removed', async () => {
    assert.equal(await allowed('https://portal.test'), null);
    const made = await gateway.call('POST', '/v1/admin/origins', {
      body: { origin: 'https://Portal.test/' },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.data.origin, 'https://portal.test');
    assert.equal(await allowed('https://portal.test'), 'https://portal.test');

    const list = await gateway.call('GET', '/v1/admin/origins');
    assert.deepEqual(
      list.body.data.map((o: { origin: string; source: string }) => [o.origin, o.source]),
      [['http://admin.test', 'environment'], ['https://portal.test', 'admin']],
    );
    const gone = await gateway.call('DELETE', `/v1/admin/origins/${made.body.data.id}`);
    assert.equal(gone.status, 204);
    assert.equal(await allowed('https://portal.test'), null);
    assert.equal(await allowed('http://admin.test'), 'http://admin.test');
  });

  it('rejects wildcards, paths, repeats and non-admins', async () => {
    for (const bad of ['*', 'https://*.test', 'https://a.test/path', 'ftp://a.test', 'nonsense']) {
      const r = await gateway.call('POST', '/v1/admin/origins', { body: { origin: bad } });
      assert.equal(r.status, 400, bad);
    }
    assert.equal((await gateway.call('POST', '/v1/admin/origins', { body: { origin: 'http://admin.test' } })).status, 409);
    assert.equal((await gateway.call('GET', '/v1/admin/origins', { token: null })).status, 401);
  });
});
