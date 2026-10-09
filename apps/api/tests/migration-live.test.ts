/**
 * Migration against a REAL PostgreSQL server.
 *
 *   SETHUCMS_TEST_PG_URL=postgres://user:pass@localhost:5432/db npm test
 *
 * Skipped when the variable is not set. Each run makes temporary schemas and removes them.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { startGateway, type TestGateway } from './helpers.js';

// Opt-in via environment; without a server these tests report as skipped.
const url = process.env['SETHUCMS_TEST_PG_URL'];
const live = (name: string, run: () => Promise<void>) =>
  it(name, { skip: url ? false : 'set SETHUCMS_TEST_PG_URL to run' }, run);

// Shells out to psql so assertions read the database directly, not through the
// gateway under test.
function sql(text: string): string {
  return execFileSync(
    'psql',
    [url!, '-v', 'ON_ERROR_STOP=1', '-At', '-c', text],
    { encoding: 'utf8' },
  ).trim();
}

// Foreign key between tables so copy order and id remapping matter.
const ddl = (schema: string) => `
  CREATE SCHEMA "${schema}";
  CREATE TABLE "${schema}".customers (id serial PRIMARY KEY, name text NOT NULL, email text);
  CREATE TABLE "${schema}".orders (id serial PRIMARY KEY, customer_id integer REFERENCES "${schema}".customers(id), total numeric(10,2), note text);
`;

async function pg(
  t: TestGateway,
  name: string,
  schema: string,
): Promise<string> {
  const parsed = new URL(url!);
  const made = await t.call('POST', '/v1/admin/connections', {
    body: {
      name,
      adapter: 'postgres',
      mode: 'read_write',
      expose: 'all',
      config: {
        host: parsed.hostname,
        port: Number(parsed.port || 5432),
        database: parsed.pathname.slice(1),
        schema,
        ssl: false,
      },
      credentials: {
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      },
    },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.data.id;
}

// Polls instead of sleeping a fixed time, so slow servers do not flake.
async function finished(t: TestGateway, id: string): Promise<any> {
  for (let i = 0; i < 400; i += 1) {
    const r = await t.call('GET', `/v1/admin/migrations/${id}`);
    if (r.body.data.status !== 'running') {
      return r.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('migration did not finish');
}

describe('migration with PostgreSQL (live)', () => {
  live(
    'copies PostgreSQL to PostgreSQL keeping ids, then renumbers, and moves memory into PostgreSQL',
    async () => {
      const suffix = randomBytes(4).toString('hex');
      const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(
        (x) => `mig_${x}_${suffix}`,
      ) as [string, string, string, string];
      const t = await startGateway({ seedDemo: false });
      try {
        for (const schema of [a, b, c, d]) {
          sql(ddl(schema));
        }
        // Explicit ids with a null email and awkward quoted unicode text
        // exercise id preservation and escaping.
        sql(
          `INSERT INTO "${a}".customers (id, name, email) VALUES (10, 'Asha', 'asha@example.com'), (20, 'Ravi', NULL), (30, 'Meera', 'm@example.com')`,
        );
        sql(
          `INSERT INTO "${a}".orders (id, customer_id, total, note) VALUES (100, 10, 10.50, 'first'), (200, 20, 20.00, NULL), (300, 10, 30.25, 'três café ☕ ''quoted''')`,
        );

        const source = await pg(t, 'Source', a);
        const keep = await pg(t, 'Keeps ids', b);
        const renumber = await pg(t, 'Renumbers', c);

        // 1. PostgreSQL -> PostgreSQL, same ids.
        let plan = await t.call('POST', '/v1/admin/migrations/plan', {
          body: { source, target: keep, preserveIds: true },
        });
        assert.equal(
          plan.body.data.ready,
          true,
          JSON.stringify(plan.body.data),
        );
        assert.deepEqual(
          plan.body.data.collections.map((x: any) => x.from),
          ['customers', 'orders'],
        );
        let job = await finished(
          t,
          (
            await t.call('POST', '/v1/admin/migrations', {
              body: { source, target: keep, preserveIds: true },
            })
          ).body.data.id,
        );
        assert.equal(job.status, 'completed', JSON.stringify(job));
        // Row counts verified with zero differences prove the copy matched
        // the source, not just that it finished.
        assert.deepEqual(
          job.collections.map((x: any) => [
            x.created,
            x.failed,
            x.verified,
            x.differences,
          ]),
          [
            [3, 0, true, 0],
            [3, 0, true, 0],
          ],
        );
        assert.equal(
          sql(
            `SELECT string_agg(id::text, ',' ORDER BY id) FROM "${b}".customers`,
          ),
          '10,20,30',
        );
        assert.equal(
          sql(`SELECT total::text FROM "${b}".orders WHERE id = 100`),
          '10.50',
        );
        assert.equal(
          sql(`SELECT note FROM "${b}".orders WHERE id = 300`),
          `três café ☕ 'quoted'`,
        );
        // The foreign key counts must match, or references were lost in the
        // copy.
        assert.equal(
          sql(`SELECT count(*) FROM "${b}".orders WHERE customer_id = 10`),
          '2',
        );

        // Running it again changes nothing.
        job = await finished(
          t,
          (
            await t.call('POST', '/v1/admin/migrations', {
              body: { source, target: keep, preserveIds: true },
            })
          ).body.data.id,
        );
        assert.deepEqual(
          job.collections.map((x: any) => [x.created, x.skipped]),
          [
            [0, 3],
            [0, 3],
          ],
        );

        // 2. Same source, target numbers its own records: references follow the new ids.
        plan = await t.call('POST', '/v1/admin/migrations/plan', {
          body: { source, target: renumber },
        });
        assert.equal(plan.body.data.collections[0].idsPreserved, false);
        job = await finished(
          t,
          (
            await t.call('POST', '/v1/admin/migrations', {
              body: { source, target: renumber },
            })
          ).body.data.id,
        );
        assert.equal(job.status, 'completed', JSON.stringify(job));
        assert.equal(
          sql(
            `SELECT count(*) FROM "${c}".orders o JOIN "${c}".customers cu ON cu.id = o.customer_id WHERE cu.name = 'Asha'`,
          ),
          '2',
        );
        assert.equal(
          sql(`SELECT count(*) FROM "${c}".customers WHERE id IN (10,20,30)`),
          '0',
          'ids were assigned by the target',
        );

        // 3. Memory -> PostgreSQL.
        const mem = await t.call('POST', '/v1/admin/connections', {
          body: {
            name: 'Memory',
            adapter: 'memory',
            mode: 'read_write',
            expose: 'all',
            config: {
              collections: [
                {
                  name: 'customers',
                  fields: [
                    {
                      name: 'id',
                      type: 'integer',
                      primaryKey: true,
                      required: true,
                    },
                    { name: 'name', type: 'string', required: true },
                    { name: 'email', type: 'string' },
                  ],
                  relations: [],
                },
              ],
            },
          },
        });
        const memId = mem.body.data.id;
        await t.call(
          'POST',
          `/v1/connections/${memId}/collections/customers/records`,
          { body: { id: 7, name: 'Lena', email: 'lena@example.com' } },
        );
        const toPg = await pg(t, 'Final', d);
        job = await finished(
          t,
          (
            await t.call('POST', '/v1/admin/migrations', {
              body: {
                source: memId,
                target: toPg,
                collections: ['customers'],
                preserveIds: true,
              },
            })
          ).body.data.id,
        );
        assert.equal(job.status, 'completed', JSON.stringify(job));
        assert.equal(
          sql(`SELECT name || ':' || id FROM "${d}".customers`),
          'Lena:7',
        );

        // 4. PostgreSQL -> memory cannot keep generated ids; it says so rather than pretending.
        const memTarget = await t.call('POST', '/v1/admin/connections', {
          body: {
            name: 'Memory target',
            adapter: 'memory',
            mode: 'read_write',
            expose: 'all',
            config: {
              collections: [
                {
                  name: 'customers',
                  fields: [
                    {
                      name: 'id',
                      type: 'integer',
                      primaryKey: true,
                      generated: true,
                    },
                    { name: 'name', type: 'string', required: true },
                    { name: 'email', type: 'string' },
                  ],
                  relations: [],
                },
              ],
            },
          },
        });
        job = await finished(
          t,
          (
            await t.call('POST', '/v1/admin/migrations', {
              body: {
                source,
                target: memTarget.body.data.id,
                collections: ['customers'],
                preserveIds: true,
              },
            })
          ).body.data.id,
        );
        assert.notEqual(job.status, 'completed');
        assert.match(JSON.stringify(job.errors), /ignored the original id/);
      } finally {
        await t.close();
        for (const schema of [a, b, c, d]) {
          try {
            sql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } catch {
            /* best effort */
          }
        }
      }
    },
  );
});
