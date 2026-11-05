/** CORS origins added from the admin panel work next to the environment list. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { matchesOrigin, OriginWatch, parseOriginPattern } from '../src/security/origins.js';
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

  it('lists only their own origins to a workspace owner, but keeps the fixed ones allowed', async () => {
    const own = await startGateway({ workspace: true });
    try {
      const list = await own.call('GET', '/v1/admin/origins');
      assert.deepEqual(list.body.data, []);
      const made = await own.call('POST', '/v1/admin/origins', { body: { origin: 'https://shop.test' } });
      assert.equal(made.status, 201);
      const after = await own.call('GET', '/v1/admin/origins');
      assert.deepEqual(after.body.data.map((o: { origin: string }) => o.origin), ['https://shop.test']);
      const fixed = (await own.call('GET', '/v1/health/live', { token: null, headers: { Origin: 'http://admin.test' } }))
        .headers.get('access-control-allow-origin');
      assert.equal(fixed, 'http://admin.test');
    } finally {
      await own.close();
    }
  });
});

describe('sign-in bridge origin check', () => {
  let gateway: TestGateway;
  before(async () => {
    gateway = await startGateway();
  });
  after(async () => {
    await gateway?.close();
  });
  const check = async (origin: string) =>
    (await gateway.call('GET', `/v1/auth/bridge-origin?origin=${encodeURIComponent(origin)}`, { token: null })).body
      .data.allowed;

  it('says yes only for sites this gateway allows, without a sign-in', async () => {
    assert.equal(await check('https://site.test'), false);
    assert.equal(await check('nonsense'), false);
    assert.equal(await check(''), false);
    await gateway.call('POST', '/v1/admin/origins', { body: { origin: 'https://site.test' } });
    assert.equal(await check('https://site.test'), true);
    assert.equal(await check('https://site.test/'), true);
    assert.equal(await check('https://other.test'), false);
  });
});

describe('refused sites and last use', () => {
  let gateway: TestGateway;
  before(async () => {
    gateway = await startGateway();
  });
  after(async () => {
    await gateway?.close();
  });

  const visit = (origin: string) =>
    gateway.call('GET', '/v1/health/live', { token: null, headers: { Origin: origin } });

  it('lists a refused site once, with a count, until it is allowed', async () => {
    await visit('https://stranger.test');
    await visit('https://stranger.test');
    const before = await gateway.call('GET', '/v1/admin/origins');
    const row = before.body.blocked.find((b: { origin: string }) => b.origin === 'https://stranger.test');
    assert.equal(row.count, 2);
    assert.ok(row.firstSeenAt <= row.lastSeenAt);

    const made = await gateway.call('POST', '/v1/admin/origins', { body: { origin: 'https://stranger.test' } });
    assert.equal(made.status, 201);
    const after = await gateway.call('GET', '/v1/admin/origins');
    assert.equal(after.body.blocked.some((b: { origin: string }) => b.origin === 'https://stranger.test'), false);
  });

  it('does not list the gateway\'s own address, which its admin page sends on its own requests', async () => {
    await visit(gateway.url); // same host as the request itself
    const list = await gateway.call('GET', '/v1/admin/origins');
    assert.equal(list.body.blocked.some((b: { origin: string }) => b.origin === gateway.url), false);
  });

  it('ignores values that are not a plain origin and keeps the list short', async () => {
    for (const odd of ['null', 'https://x.test/path', 'ftp://x.test', 'x'.repeat(300), 'https://user@x.test']) {
      await visit(odd);
    }
    for (let i = 0; i < 30; i += 1) {
      await visit(`https://site-${i}.test`);
    }
    const list = await gateway.call('GET', '/v1/admin/origins');
    const names = list.body.blocked.map((b: { origin: string }) => b.origin);
    assert.ok(names.length <= 20, `kept ${names.length}`);
    assert.ok(names.every((n: string) => /^https:\/\/site-\d+\.test$/.test(n)), names.join(','));
  });

  it('shows when an allowed origin was last used', async () => {
    const quiet = await gateway.call('GET', '/v1/admin/origins');
    const env = quiet.body.data.find((o: { origin: string }) => o.origin === 'http://admin.test');
    assert.equal(env.lastSeenAt, null);
    await visit('http://admin.test');
    const used = await gateway.call('GET', '/v1/admin/origins');
    const again = used.body.data.find((o: { origin: string }) => o.origin === 'http://admin.test');
    assert.match(again.lastSeenAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('answers a preflight with the tracing headers for allowed sites only', async () => {
    const ok = await gateway.call('OPTIONS', '/v1/connections', { token: null, headers: { Origin: 'http://admin.test' } });
    assert.equal(ok.status, 204);
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /Traceparent/);
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /X-Request-Id/);
    assert.equal(ok.headers.get('access-control-allow-credentials'), null);
    const no = await gateway.call('OPTIONS', '/v1/connections', { token: null, headers: { Origin: 'https://nobody.test' } });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
    assert.equal(no.headers.get('vary'), 'Origin');
  });

  it('keeps wildcards off unless the owner switches them on', async () => {
    const list = await gateway.call('GET', '/v1/admin/origins');
    assert.equal(list.body.wildcardsEnabled, false);
    const r = await gateway.call('POST', '/v1/admin/origins', { body: { origin: 'https://*.preview.test' } });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /SETHUCMS_ALLOW_WILDCARD_ORIGINS/);
  });
});

describe('one-label wildcard origins (switched on)', () => {
  let gateway: TestGateway;
  before(async () => {
    gateway = await startGateway({ allowWildcardOrigins: true });
  });
  after(async () => {
    await gateway?.close();
  });

  const allowed = async (origin: string) =>
    (await gateway.call('GET', '/v1/health/live', { token: null, headers: { Origin: origin } }))
      .headers.get('access-control-allow-origin');

  it('allows exactly one label in place of the star', async () => {
    const made = await gateway.call('POST', '/v1/admin/origins', { body: { origin: 'https://*.Preview.test' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.data.origin, 'https://*.preview.test');
    assert.equal((await gateway.call('GET', '/v1/admin/origins')).body.wildcardsEnabled, true);

    assert.equal(await allowed('https://pr-12.preview.test'), 'https://pr-12.preview.test');
    for (const no of [
      'https://preview.test',
      'https://a.b.preview.test',
      'http://pr-12.preview.test',
      'https://pr-12.preview.test:8443',
      'https://-.preview.test',
      'https://evilpreview.test',
      'https://pr-12.preview.test.evil.test',
    ]) {
      assert.equal(await allowed(no), null, no);
    }
  });

  it('refuses shared hosting, country domains and badly placed stars', async () => {
    for (const bad of [
      '*',
      'https://*',
      'https://*.com',
      'https://*.co.uk',
      'https://*.vercel.app',
      'https://*.my-team.vercel.app',
      'https://*.github.io',
      'http://*.example.com',
      'https://*.*.example.com',
      'https://a.*.example.com',
      'https://*example.com',
      'https://*.example.com:8443',
      'https://*.example.com/path',
    ]) {
      const r = await gateway.call('POST', '/v1/admin/origins', { body: { origin: bad } });
      assert.equal(r.status, 400, bad);
    }
  });

  it('stops a saved wildcard from matching once wildcards are switched off', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethu-origins-'));
    try {
      const on = await startGateway({ dataDir: dir, allowWildcardOrigins: true });
      try {
        const made = await on.call('POST', '/v1/admin/origins', { body: { origin: 'https://*.keep.test' } });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        const hit = await on.call('GET', '/v1/health/live', { token: null, headers: { Origin: 'https://a.keep.test' } });
        assert.equal(hit.headers.get('access-control-allow-origin'), 'https://a.keep.test');
      } finally {
        await on.close();
      }
      const off = await startGateway({ dataDir: dir, allowWildcardOrigins: false });
      try {
        const saved = await off.call('GET', '/v1/admin/origins');
        assert.ok(saved.body.data.some((o: { origin: string }) => o.origin === 'https://*.keep.test'), 'entry is still saved');
        const miss = await off.call('GET', '/v1/health/live', { token: null, headers: { Origin: 'https://a.keep.test' } });
        assert.equal(miss.headers.get('access-control-allow-origin'), null);
      } finally {
        await off.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never lets the environment list act as a wildcard', async () => {
    const env = await startGateway({ allowWildcardOrigins: true, allowedOrigins: ['https://*.env.test'] });
    try {
      const r = await env.call('GET', '/v1/health/live', { token: null, headers: { Origin: 'https://a.env.test' } });
      assert.equal(r.headers.get('access-control-allow-origin'), null);
    } finally {
      await env.close();
    }
  });
});

describe('origin rules (no server)', () => {
  it('normalises exact origins and rejects the rest', () => {
    assert.equal(parseOriginPattern(' HTTPS://Example.com/ ', false).origin, 'https://example.com');
    assert.equal(parseOriginPattern('http://localhost:3000', false).origin, 'http://localhost:3000');
    for (const bad of ['', 'nonsense', 'https://a.test/x', 'https://a.test?x=1', 'https://u:p@a.test', 'file:///x']) {
      assert.throws(() => parseOriginPattern(bad, false), bad);
    }
  });

  it('matches exact entries exactly and wildcard entries by one label', () => {
    assert.equal(matchesOrigin('https://a.test', 'https://a.test'), true);
    assert.equal(matchesOrigin('https://a.test', 'https://b.a.test'), false);
    assert.equal(matchesOrigin('https://*.a.test', 'https://b.a.test'), true);
    assert.equal(matchesOrigin('https://*.a.test', 'https://b.c.a.test'), false);
    assert.equal(matchesOrigin('https://*.a.test', 'https://a.test'), false);
  });

  it('records refused sites in order and forgets the stalest first', () => {
    const watch = new OriginWatch();
    watch.seen('https://one.test', false, new Date('2026-01-01T00:00:00Z'));
    watch.seen('https://two.test', false, new Date('2026-01-01T00:00:01Z'));
    watch.seen('https://one.test', false, new Date('2026-01-01T00:00:02Z'));
    assert.deepEqual(watch.blocked().map((b) => [b.origin, b.count]), [['https://one.test', 2], ['https://two.test', 1]]);
    watch.clearAllowedBy('https://*.two.test'); // does not match: different host
    assert.equal(watch.blocked().length, 2);
    watch.clearAllowedBy('https://two.test');
    assert.deepEqual(watch.blocked().map((b) => b.origin), ['https://one.test']);
  });
});
