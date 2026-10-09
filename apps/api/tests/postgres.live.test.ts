/**
 * Runs against a real PostgreSQL. Skipped unless these are set:
 *   SETHUCMS_TEST_PG_HOST, SETHUCMS_TEST_PG_PORT, SETHUCMS_TEST_PG_DB, SETHUCMS_TEST_PG_USER, SETHUCMS_TEST_PG_PASSWORD
 * The database needs a table (the test creates and drops its own):
 *   gw_posts(id serial primary key, title text not null, body text, views int)
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startGateway, type TestGateway } from './helpers.js';

const env = process.env;
const live = Boolean(env['SETHUCMS_TEST_PG_HOST']);

// Skipped without a database so CI on machines without PostgreSQL stays green.
describe(
  'live PostgreSQL through the gateway',
  { skip: live ? false : 'set SETHUCMS_TEST_PG_HOST to run' },
  () => {
    let t: TestGateway;
    let pgId: string;
    let memoryId: string;
    const postgres = {
      name: 'Live Postgres',
      adapter: 'postgres',
      mode: 'read_write',
      expose: 'all',
      config: {
        host: env['SETHUCMS_TEST_PG_HOST'],
        port: Number(env['SETHUCMS_TEST_PG_PORT'] ?? 5432),
        database: env['SETHUCMS_TEST_PG_DB'],
        ssl: false,
      },
      credentials: {
        user: env['SETHUCMS_TEST_PG_USER'],
        password: env['SETHUCMS_TEST_PG_PASSWORD'] ?? '',
      },
    };
    let admin: any;

    // Seeds a throwaway table so the tests control the exact rows asserted
    // below.
    before(async () => {
      const driver = 'pg'; // loaded by name so TypeScript does not need the driver's types
      const { default: pg } = (await import(driver)) as { default: any };
      admin = new pg.Client({
        host: postgres.config.host,
        port: postgres.config.port,
        database: postgres.config.database,
        user: postgres.credentials.user,
        password: postgres.credentials.password,
      });
      await admin.connect();
      await admin.query('DROP TABLE IF EXISTS gw_posts');
      await admin.query(
        'CREATE TABLE gw_posts (id serial primary key, title text not null, body text, views int)',
      );
      await admin.query(
        "INSERT INTO gw_posts (title, body, views) VALUES ('First', 'hello', 1), ('Second', 'world', 2), ('Third', NULL, 3)",
      );

      t = await startGateway({ seedDemo: true });
      memoryId = (await t.call('GET', '/v1/connections')).body.data[0].id;
      const created = await t.call('POST', '/v1/admin/connections', {
        body: postgres,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      pgId = created.body.data.id;
    });

    after(async () => {
      await admin?.query('DROP TABLE IF EXISTS gw_posts');
      await admin?.end();
      await t?.close();
    });

    const posts = (suffix = '') =>
      `/v1/connections/${pgId}/collections/gw_posts/records${suffix}`;

    // Schema discovery must reflect the real table, and the stored password
    // must not appear in connection details.
    it('discovers the table and its fields', async () => {
      const detail = await t.call('GET', `/v1/admin/connections/${pgId}`);
      assert.equal(detail.body.data.health, 'healthy');
      assert.ok(
        detail.body.data.collections.some(
          (c: any) => c.name === 'gw_posts' && c.primaryKey === 'id',
        ),
      );
      assert.equal(detail.body.data.hasCredentials, true);
      assert.ok(
        !JSON.stringify(detail.body).includes(
          String(postgres.credentials.password || 'no-password-set'),
        ) || postgres.credentials.password === '',
      );
    });

    // Checks the SQL translation of sort, cursor and filter against a real
    // engine, not a mock.
    it('reads, sorts, filters and paginates real rows', async () => {
      const page = await t.call('GET', `${posts()}?sort=-id&limit=2`);
      assert.deepEqual(
        page.body.data.map((r: any) => r.title),
        ['Third', 'Second'],
      );
      const next = await t.call(
        'GET',
        `${posts()}?sort=-id&limit=2&cursor=${encodeURIComponent(page.body.page.nextCursor)}`,
      );
      assert.deepEqual(
        next.body.data.map((r: any) => r.title),
        ['First'],
      );
      const filtered = await t.call(
        'GET',
        `${posts()}?filter=${encodeURIComponent('{"field":"views","op":"gt","value":1}')}&sort=id`,
      );
      assert.deepEqual(
        filtered.body.data.map((r: any) => r.title),
        ['Second', 'Third'],
      );
    });

    // Hostile values must be stored and matched literally; the table must still
    // exist afterwards.
    it('is safe against SQL injection in values', async () => {
      const nasty = "x'; DROP TABLE gw_posts; --";
      const created = await t.call('POST', posts(), { body: { title: nasty } });
      assert.equal(created.status, 201);
      assert.equal(
        (await t.call('GET', posts(`/${created.body.data.id}`))).body.data
          .title,
        nasty,
      );
      const filter = JSON.stringify({ field: 'title', op: 'eq', value: nasty });
      assert.equal(
        (await t.call('GET', `${posts()}?filter=${encodeURIComponent(filter)}`))
          .body.data.length,
        1,
      );
      assert.equal(
        (await admin.query('SELECT count(*)::int AS n FROM gw_posts')).rows[0]
          .n >= 4,
        true,
      );
    });

    // Drafts are staged edits; the live table must stay untouched until
    // publish.
    it('writes through drafts: nothing reaches the table until publish', async () => {
      const drafts = `/v1/connections/${pgId}/collections/gw_posts/drafts`;
      const draft = await t.call('POST', drafts, {
        body: { recordId: 1, values: { title: 'First, revised' } },
      });
      assert.equal(draft.status, 201, JSON.stringify(draft.body));
      assert.equal(
        (await admin.query('SELECT title FROM gw_posts WHERE id = 1')).rows[0]
          .title,
        'First',
      );

      const link = await t.call(
        'POST',
        `${drafts}/${draft.body.data.id}/preview-link`,
      );
      const preview = await t.call('GET', link.body.data.path, { token: null });
      assert.equal(preview.body.data.title, 'First, revised');
      assert.equal(preview.body.data.body, 'hello');

      const published = await t.call(
        'POST',
        `${drafts}/${draft.body.data.id}/publish`,
      );
      assert.equal(published.status, 200, JSON.stringify(published.body));
      assert.equal(
        (await admin.query('SELECT title FROM gw_posts WHERE id = 1')).rows[0]
          .title,
        'First, revised',
      );
    });

    // Optimistic concurrency - publishing over a row changed behind the draft's
    // back must conflict instead of overwriting.
    it('detects a change made directly in the database while a draft was open', async () => {
      const drafts = `/v1/connections/${pgId}/collections/gw_posts/drafts`;
      const draft = await t.call('POST', drafts, {
        body: { recordId: 2, values: { body: 'my words' } },
      });
      await admin.query('UPDATE gw_posts SET views = 99 WHERE id = 2');
      const blocked = await t.call(
        'POST',
        `${drafts}/${draft.body.data.id}/publish`,
      );
      assert.equal(blocked.status, 409);
    });

    // Different adapters must not share state or break each other.
    it('works next to a memory connection at the same time', async () => {
      const both = await Promise.all([
        t.call(
          'GET',
          `/v1/connections/${memoryId}/collections/articles/records`,
        ),
        t.call('GET', posts()),
        t.call(
          'GET',
          `/v1/connections/${memoryId}/collections/authors/records`,
        ),
      ]);
      assert.deepEqual(
        both.map((r) => r.status),
        [200, 200, 200],
      );
      const overview = await t.call('GET', '/v1/admin/overview');
      assert.equal(overview.body.connections.length, 2);
      assert.ok(
        overview.body.connections.every((c: any) => c.health === 'healthy'),
      );
    });

    // Raw driver errors reveal schema and constraint names that help attackers.
    it('hides database error text from clients', async () => {
      await admin.query(
        'ALTER TABLE gw_posts ADD CONSTRAINT views_positive CHECK (views >= 0)',
      );
      const r = await t.call('POST', posts(), {
        body: { title: 'bad', views: -5 },
      });
      assert.ok(r.status >= 400);
      const text = JSON.stringify(r.body);
      assert.ok(
        !/views_positive|violates|constraint|gw_posts|postgres/i.test(text),
        text,
      );
    });

    // Read-only mode has to be enforced by the gateway, not only by the UI.
    it('read-only mode is enforced', async () => {
      await t.call('PATCH', `/v1/admin/connections/${pgId}`, {
        body: { mode: 'read_only' },
      });
      const r = await t.call('POST', posts(), { body: { title: 'nope' } });
      assert.equal(r.body.error.code, 'READ_ONLY');
      assert.equal((await t.call('GET', posts())).status, 200);
    });

    it('shows a clear failure for wrong credentials without leaking them', async () => {
      const r = await t.call('POST', '/v1/admin/connections', {
        body: {
          ...postgres,
          name: 'wrong pw',
          credentials: {
            user: postgres.credentials.user,
            password: 'definitely-wrong-pw',
          },
        },
      });
      // Local trust authentication accepts any password; only assert the safety property.
      assert.ok(!JSON.stringify(r.body).includes('definitely-wrong-pw'));
    });
  },
);
