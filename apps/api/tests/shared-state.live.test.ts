/**
 * Two gateways sharing state through a real PostgreSQL. Skipped unless these are set:
 *   SETHUCMS_TEST_PG_HOST, SETHUCMS_TEST_PG_PORT, SETHUCMS_TEST_PG_USER, SETHUCMS_TEST_PG_PASSWORD
 * The test makes and drops its own database.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_TOKEN,
  readEvents,
  startGateway,
  type TestGateway,
} from './helpers.js';

const env = process.env;
const live = Boolean(env['SETHUCMS_TEST_PG_HOST']);
// Random database name so concurrent runs cannot interfere.
const DB = `sethucms_shared_${randomBytes(3).toString('hex')}`;

const credentials = `${encodeURIComponent(env['SETHUCMS_TEST_PG_USER'] ?? 'postgres')}${env['SETHUCMS_TEST_PG_PASSWORD'] ? ':' + encodeURIComponent(env['SETHUCMS_TEST_PG_PASSWORD']) : ''}`;
const urlFor = (database: string): string =>
  `postgres://${credentials}@${env['SETHUCMS_TEST_PG_HOST']}:${env['SETHUCMS_TEST_PG_PORT'] ?? 5432}/${database}`;

const secrets = {
  SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
  SETHUCMS_VAULT_KEY: randomBytes(32).toString('base64'),
  SETHUCMS_CURSOR_SECRET: randomBytes(32).toString('base64'),
  SETHUCMS_PREVIEW_SECRET: randomBytes(32).toString('base64'),
};

// Polling helper - sync between gateways is eventual (statePollMs), so
// assertions wait rather than race.
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => Promise<T | undefined | false>,
  what: string,
): Promise<T> {
  for (let i = 0; i < 60; i += 1) {
    const value = await read();
    if (value) {
      return value;
    }
    await wait(100);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe(
  'two gateways sharing state (live PostgreSQL)',
  { skip: live ? false : 'set SETHUCMS_TEST_PG_HOST to run' },
  () => {
    let admin: any;
    let a: TestGateway;
    let b: TestGateway;

    // Loads the pg driver by name so the suite compiles and skips when it is
    // not installed.
    before(async () => {
      const driver = 'pg';
      const { default: pg } = (await import(driver)) as { default: any };
      admin = new pg.Client({ connectionString: urlFor('postgres') });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${DB}`);
      // Both gateways point at the same state database, simulating a
      // horizontally scaled deployment.
      const options = {
        seedDemo: false,
        stateUrl: urlFor(DB),
        statePollMs: 200,
        dataDir: undefined,
      };
      a = await startGateway(options, { env: secrets });
      b = await startGateway(options, { env: secrets });
    });

    after(async () => {
      await a?.close();
      await b?.close();
      await admin
        ?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
        .catch(() => undefined);
      await admin?.end();
    });

    // Revocation must propagate everywhere; otherwise a stolen token stays
    // valid on the other node.
    it('a token made on one gateway works on the other, and revoking it stops it on both', async () => {
      const created = await a.call('POST', '/v1/admin/tokens', {
        body: { name: 'shared editor', role: 'editor' },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const token = created.body.data.token as string;
      const id = created.body.data.id as string;

      await until(
        async () =>
          (await b.call('GET', '/v1/connections', { token })).status === 200,
        'token accepted on gateway B',
      );

      assert.equal(
        (await b.call('DELETE', `/v1/admin/tokens/${id}`)).status,
        204,
      );
      await until(
        async () =>
          (await a.call('GET', '/v1/connections', { token })).status === 401,
        'revocation seen on gateway A',
      );
      assert.equal(
        (await b.call('GET', '/v1/connections', { token })).status,
        401,
      );
    });

    // Config changes made on one node must reach the others without a restart.
    it('a connection made on one gateway appears on the other, and a change is picked up', async () => {
      const created = await a.call('POST', '/v1/admin/connections', {
        body: {
          name: 'Shared demo',
          adapter: 'memory',
          mode: 'read_write',
          expose: 'all',
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const id = created.body.data.id as string;

      await until(
        async () =>
          (await b.call('GET', '/v1/connections')).body.data.some(
            (c: any) => c.id === id,
          ),
        'connection visible on B',
      );

      const renamed = await b.call('PATCH', `/v1/admin/connections/${id}`, {
        body: { name: 'Renamed on B' },
      });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      await until(
        async () =>
          (await a.call('GET', '/v1/connections')).body.data.find(
            (c: any) => c.id === id,
          )?.name === 'Renamed on B',
        'rename visible on A',
      );
    });

    // A burst of concurrent writes from both nodes tests optimistic locking - a
    // lost update would leave fewer than 24 tokens.
    it('does not lose changes when both gateways write at the same moment', async () => {
      const before = (await a.call('GET', '/v1/admin/tokens')).body.data
        .length as number;
      const calls = Array.from({ length: 24 }, (_, i) =>
        (i % 2 === 0 ? a : b).call('POST', '/v1/admin/tokens', {
          body: { name: `burst ${i}`, role: 'viewer' },
        }),
      );
      const results = await Promise.all(calls);
      assert.ok(
        results.every((r) => r.status === 201),
        results.map((r) => r.status).join(','),
      );
      await until(
        async () =>
          (await a.call('GET', '/v1/admin/tokens')).body.data.length ===
          before + 24,
        'all 24 tokens on A',
      );
      await until(
        async () =>
          (await b.call('GET', '/v1/admin/tokens')).body.data.length ===
          before + 24,
        'all 24 tokens on B',
      );
    });

    // The audit log is a hash chain; split writes across nodes must still
    // verify, or tampering could not be detected.
    it('shares the audit log: both gateways see every entry and the chains verify', async () => {
      await a.call('POST', '/v1/admin/tokens', {
        body: { name: 'audit from A', role: 'viewer' },
      });
      await b.call('POST', '/v1/admin/tokens', {
        body: { name: 'audit from B', role: 'viewer' },
      });
      await until(async () => {
        const seen = (await a.call('GET', '/v1/admin/audit?limit=500')).body
          .data as Array<{ operation: string; detail?: { name?: string } }>;
        return (
          seen.some((e) => e.detail?.name === 'audit from A') &&
          seen.some((e) => e.detail?.name === 'audit from B')
        );
      }, 'both entries visible through gateway A');

      const verified = (await b.call('GET', '/v1/admin/audit/verify')).body
        .data;
      assert.equal(verified.ok, true, JSON.stringify(verified));
      assert.ok(verified.checked >= 2);
    });

    // A retry that lands on another node must replay, not create a duplicate,
    // so the key store has to be shared.
    it('an Idempotency-Key is honoured even when the retry reaches the other gateway', async () => {
      const id = (await a.call('GET', '/v1/connections')).body.data[0]
        .id as string;
      const path = `/v1/connections/${id}/collections/authors/records`;
      const headers = {
        'Idempotency-Key': `shared-${randomBytes(4).toString('hex')}`,
      };
      const first = await a.call('POST', path, {
        body: { name: 'Only once' },
        headers,
      });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const retry = await b.call('POST', path, {
        body: { name: 'Only once' },
        headers,
      });
      assert.equal(retry.status, 201);
      assert.equal(retry.headers.get('idempotent-replay'), 'true');
      assert.deepEqual(retry.body, first.body);

      const different = await b.call('POST', path, {
        body: { name: 'Something else' },
        headers,
      });
      assert.equal(different.status, 409);
    });

    // Events must cross nodes, since a client's stream may connect to a
    // different node than the write.
    it('live events made on one gateway reach a listener on the other', async () => {
      const id = (await a.call('GET', '/v1/connections')).body.data[0]
        .id as string;
      const events = await readEvents(
        `${b.url}/v1/events`,
        { Authorization: `Bearer ${ADMIN_TOKEN}` },
        2,
        async () => {
          await a.call(
            'POST',
            `/v1/connections/${id}/collections/authors/records`,
            { body: { name: 'Seen across gateways' } },
          );
        },
      );
      const types = events.map((e) => e.event);
      assert.ok(types.includes('record.created'), `got ${types.join(',')}`);
    });
  },
);
