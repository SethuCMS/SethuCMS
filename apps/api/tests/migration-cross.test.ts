/**
 * Moving data between different database types, creating the missing tables.
 *
 * SQLite is always tested (it ships with Node). The others run when a server is
 * available:
 *
 *   SETHUCMS_TEST_PG_URL=postgres://user:pass@localhost:5432/db
 *   SETHUCMS_TEST_MYSQL_URL=mysql://user:pass@localhost:3306         (needs CREATE/DROP DATABASE rights)
 *   SETHUCMS_TEST_MONGO_URL=mongodb://localhost:27017
 *
 * The source is always a SQLite file with two linked tables. Each target starts empty.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMysqlClient } from '@sethucms/adapter-mysql';
import { createMongoClient } from '@sethucms/adapter-mongodb';
import { FirestoreAdapter } from '@sethucms/adapter-firestore';
import type { AdapterKind } from '../src/connections/adapters.js';
import { createFakeFirestore } from './fake-firestore.js';
import { startGateway, type TestGateway } from './helpers.js';

// Optional servers are opt-in via environment, so the suite stays green on
// machines without them.
const pgUrl = process.env['SETHUCMS_TEST_PG_URL'];
const mysqlUrl = process.env['SETHUCMS_TEST_MYSQL_URL'];
const mongoUrl = process.env['SETHUCMS_TEST_MONGO_URL'];

// One entry per target database; make() provisions an isolated, empty target
// and cleanup() removes it.
interface Target {
  label: string;
  run: boolean;
  kinds?: Record<string, AdapterKind>;
  make(
    t: TestGateway,
    name: string,
  ): Promise<{ id: string; cleanup(): Promise<void> }>;
}

async function connect(
  t: TestGateway,
  body: Record<string, unknown>,
): Promise<string> {
  const made = await t.call('POST', '/v1/admin/connections', {
    body: { mode: 'read_write', expose: 'none', ...body },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.data.id as string;
}

const targets: Target[] = [
  {
    label: 'SQLite',
    run: true,
    async make(t, name) {
      return {
        id: await connect(t, {
          name,
          adapter: 'sqlite',
          config: { path: `${name}.db` },
        }),
        cleanup: async () => undefined,
      };
    },
  },
  {
    label: 'PostgreSQL',
    run: Boolean(pgUrl),
    async make(t, name) {
      const url = new URL(pgUrl!);
      const psql = (text: string) =>
        execFileSync(
          'psql',
          [pgUrl!, '-v', 'ON_ERROR_STOP=1', '-At', '-c', text],
          { encoding: 'utf8' },
        );
      psql(`CREATE SCHEMA "${name}"`);
      const id = await connect(t, {
        name,
        adapter: 'postgres',
        config: {
          host: url.hostname,
          port: Number(url.port || 5432),
          database: url.pathname.slice(1),
          schema: name,
          ssl: false,
        },
        credentials: {
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        },
      });
      return {
        id,
        cleanup: async () => {
          psql(`DROP SCHEMA "${name}" CASCADE`);
        },
      };
    },
  },
  {
    label: 'MySQL / MariaDB',
    run: Boolean(mysqlUrl),
    async make(t, name) {
      const url = new URL(mysqlUrl!);
      const credentials = {
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
      const admin = await createMysqlClient({
        connectionId: 'x',
        config: {
          host: url.hostname,
          port: Number(url.port || 3306),
          database: url.pathname.slice(1) || 'mysql',
          ssl: false,
        },
        credentials,
        readOnly: false,
      });
      await admin.query(`CREATE DATABASE \`${name}\``);
      const id = await connect(t, {
        name,
        adapter: 'mysql',
        config: {
          host: url.hostname,
          port: Number(url.port || 3306),
          database: name,
          ssl: false,
        },
        credentials,
      });
      return {
        id,
        cleanup: async () => {
          await admin.query(`DROP DATABASE \`${name}\``);
          await admin.close();
        },
      };
    },
  },
  {
    label: 'MongoDB',
    run: Boolean(mongoUrl),
    async make(t, name) {
      const url = new URL(mongoUrl!);
      const config = {
        host: url.hostname,
        port: Number(url.port || 27017),
        database: name,
        tls: false,
      };
      const credentials = {
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
      const id = await connect(t, {
        name,
        adapter: 'mongodb',
        config,
        credentials,
      });
      return {
        id,
        cleanup: async () => {
          const handle = await createMongoClient({
            connectionId: 'x',
            config,
            credentials,
            readOnly: false,
          });
          await handle.db.dropDatabase();
          await handle.close();
        },
      };
    },
  },
  {
    // Firestore is tested against an in-memory stand-in only; no Firestore emulator is available here.
    label: 'Firestore (in-memory stand-in)',
    run: true,
    kinds: (() => {
      const fake = createFakeFirestore();
      return {
        firestore: {
          label: 'Firestore (stand-in)',
          create: () =>
            new FirestoreAdapter({ clientFactory: async () => fake }),
          networkHost: () => null,
        },
      };
    })(),
    async make(t, name) {
      return {
        id: await connect(t, {
          name,
          adapter: 'firestore',
          config: { projectId: 'demo-project' },
        }),
        cleanup: async () => undefined,
      };
    },
  },
];

// Fixed source data covers nulls, a foreign key, decimals, dates, JSON and
// awkward text; the null/0/1 booleans and the quoted unicode note check that
// type mapping and escaping survive the copy.
function buildSource(dir: string): void {
  const db = new DatabaseSync(join(dir, 'source.db'));
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(200), vip BOOLEAN);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total NUMERIC, note TEXT, placed DATETIME, tags JSON);
    INSERT INTO customers VALUES (10, 'Asha', 'asha@example.com', 1), (20, 'Ravi', NULL, 0), (30, 'Meera', 'm@example.com', NULL);
    INSERT INTO orders VALUES
      (100, 10, 10.5, 'first', '2024-05-06T07:08:09.000Z', '["a","b"]'),
      (200, 20, 20, NULL, NULL, NULL),
      (300, 10, 30.25, 'três café ☕ ''quoted''', '2024-06-01T00:00:00.000Z', '{"k":[1,2]}');
  `);
  db.close();
}

// Polls rather than sleeping a fixed time, so slow databases do not flake.
async function finished(t: TestGateway, id: string): Promise<any> {
  for (let i = 0; i < 600; i += 1) {
    const r = await t.call('GET', `/v1/admin/migrations/${id}`);
    if (r.body.data.status !== 'running') {
      return r.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('migration did not finish');
}

describe('moving data between database types, creating the tables', () => {
  // The same assertions run per target, which is what proves the type mapping
  // is consistent across engines.
  for (const target of targets) {
    it(
      `SQLite -> ${target.label}`,
      // A missing server must show as skipped rather than silently pass.
      { skip: target.run ? false : 'no server configured for this database' },
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'sethucms-cross-'));
        // Random name so parallel or aborted runs cannot collide.
        const name = `x${randomBytes(4).toString('hex')}`;
        const t = await startGateway(
          { seedDemo: false, sqliteDir: dir },
          target.kinds ? { adapters: target.kinds } : {},
        );
        let cleanup: (() => Promise<void>) | undefined;
        try {
          buildSource(dir);
          const source = await connect(t, {
            name: 'Source',
            adapter: 'sqlite',
            config: { path: 'source.db' },
          });
          const made = await target.make(t, name);
          cleanup = made.cleanup;
          const to = made.id;

          // Without permission to create, the plan says what is missing.
          let plan = await t.call('POST', '/v1/admin/migrations/plan', {
            body: { source, target: to },
          });
          assert.equal(plan.body.data.ready, false);
          assert.match(JSON.stringify(plan.body.data), /no collection called/);

          // With it, the plan shows what would be created, parents first.
          plan = await t.call('POST', '/v1/admin/migrations/plan', {
            body: { source, target: to, createMissing: true },
          });
          assert.equal(
            plan.body.data.ready,
            true,
            JSON.stringify(plan.body.data),
          );
          assert.deepEqual(
            plan.body.data.collections.map((c: any) => [c.from, c.create]),
            [
              ['customers', true],
              ['orders', true],
            ],
          );

          const started = await t.call('POST', '/v1/admin/migrations', {
            body: { source, target: to, createMissing: true },
          });
          assert.equal(started.status, 202, JSON.stringify(started.body));
          const job = await finished(t, started.body.data.id);
          assert.equal(job.status, 'completed', JSON.stringify(job));
          assert.deepEqual(
            job.collections.map((c: any) => [
              c.created,
              c.failed,
              c.verified,
              c.differences,
            ]),
            [
              [3, 0, true, 0],
              [3, 0, true, 0],
            ],
          );

          // The new collections exist but stay hidden until an administrator exposes them.
          const page = await t.call('GET', `/v1/admin/connections/${to}`);
          const found = page.body.data.collections
            .map((c: any) => [c.name, c.exposed])
            .sort();
          assert.deepEqual(found, [
            ['customers', false],
            ['orders', false],
          ]);
          for (const collection of ['customers', 'orders']) {
            assert.equal(
              (
                await t.call(
                  'PUT',
                  `/v1/admin/connections/${to}/collections/${collection}`,
                  { body: { exposed: true } },
                )
              ).status,
              200,
            );
          }

          const customers = await t.call(
            'GET',
            `/v1/connections/${to}/collections/customers/records?limit=50`,
          );
          assert.deepEqual(
            customers.body.data
              .map((r: any) => Number(r.id))
              .sort((a: number, b: number) => a - b),
            [10, 20, 30],
          );
          const asha = customers.body.data.find(
            (r: any) => Number(r.id) === 10,
          );
          assert.equal(asha.name, 'Asha');
          assert.equal(asha.vip, true);
          assert.equal(
            customers.body.data.find((r: any) => Number(r.id) === 30).vip,
            null,
          );

          const orders = await t.call(
            'GET',
            `/v1/connections/${to}/collections/orders/records?limit=50`,
          );
          const byId = new Map(
            orders.body.data.map((r: any) => [Number(r.id), r]),
          );
          // Round-trips values through the target; any lossy conversion would
          // show here.
          assert.equal((byId.get(300) as any).note, `três café ☕ 'quoted'`);
          assert.equal(Number((byId.get(100) as any).total), 10.5);
          assert.equal(Number((byId.get(300) as any).customer_id), 10);
          assert.deepEqual((byId.get(300) as any).tags, { k: [1, 2] });
          assert.equal(
            Date.parse((byId.get(100) as any).placed),
            Date.parse('2024-05-06T07:08:09.000Z'),
          );

          // New records continue after the copied ids (the target's counter was moved).
          const fresh = await t.call(
            'POST',
            `/v1/connections/${to}/collections/customers/records`,
            { body: { name: 'New person' } },
          );
          assert.equal(fresh.status, 201, JSON.stringify(fresh.body));
          assert.equal(Number(fresh.body.data.id), 31);

          // Running it again with the ids kept changes nothing.
          const again = await finished(
            t,
            (
              await t.call('POST', '/v1/admin/migrations', {
                body: { source, target: to, preserveIds: true },
              })
            ).body.data.id,
          );
          assert.deepEqual(
            again.collections.map((c: any) => [c.created, c.skipped]),
            [
              [0, 3],
              [0, 3],
            ],
          );
        } finally {
          await t.close();
          await cleanup?.().catch(() => undefined);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  }
});
