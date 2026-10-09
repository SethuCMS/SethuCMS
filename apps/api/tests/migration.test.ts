// Covers migrating data between connections - request validation, type
// compatibility, reference rewriting, dependency order, renames, safety
// refusals, error reporting and metrics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  defineCollection,
  referencedCollection as referenceOf,
} from '@sethucms/core';
import {
  parseMigrationRequest,
  typesCompatible,
} from '../src/migration/plan.js';
import { startGateway, tokenFor, type TestGateway } from './helpers.js';

// Builders for source and target schemas; the two collections are linked by a
// reference so ordering and id rewriting matter.
const key = (
  name = 'id',
  type = 'string',
  extra: Record<string, unknown> = {},
) => ({ name, type, primaryKey: true, required: true, ...extra });

const customers = (id = key()) => ({
  name: 'customers',
  fields: [
    id,
    { name: 'name', type: 'string', required: true },
    { name: 'email', type: 'string' },
  ],
  relations: [],
});
const orders = (id = key(), customerType = 'string') => ({
  name: 'orders',
  fields: [
    id,
    { name: 'customer_id', type: customerType, references: 'customers' },
    { name: 'total', type: 'decimal' },
  ],
  relations: [],
});

async function connect(
  t: TestGateway,
  name: string,
  collections: unknown[],
  mode = 'read_write',
): Promise<string> {
  const made = await t.call('POST', '/v1/admin/connections', {
    body: {
      name,
      adapter: 'memory',
      mode,
      expose: 'all',
      config: { collections },
    },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.data.id;
}

async function add(
  t: TestGateway,
  id: string,
  collection: string,
  values: Record<string, unknown>,
): Promise<void> {
  const r = await t.call(
    'POST',
    `/v1/connections/${id}/collections/${collection}/records`,
    { body: values },
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
}

async function records(
  t: TestGateway,
  id: string,
  collection: string,
): Promise<any[]> {
  const r = await t.call(
    'GET',
    `/v1/connections/${id}/collections/${collection}/records?limit=500`,
  );
  assert.equal(r.status, 200);
  return r.body.data;
}

// Polls rather than sleeping a fixed time, so the test finishes as soon as the
// job does.
async function finished(t: TestGateway, jobId: string): Promise<any> {
  for (let i = 0; i < 200; i += 1) {
    const r = await t.call('GET', `/v1/admin/migrations/${jobId}`);
    if (r.body.data.status !== 'running') {
      return r.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('migration did not finish');
}

async function seeded(t: TestGateway) {
  const source = await connect(t, 'Old', [customers(), orders()]);
  await add(t, source, 'customers', {
    id: 'c1',
    name: 'Asha',
    email: 'asha@example.com',
  });
  await add(t, source, 'customers', { id: 'c2', name: 'Ravi', email: null });
  await add(t, source, 'orders', { id: 'o1', customer_id: 'c1', total: 10.5 });
  await add(t, source, 'orders', { id: 'o2', customer_id: 'c2', total: 20 });
  await add(t, source, 'orders', { id: 'o3', customer_id: 'c1', total: 30 });
  return source;
}

// The request comes from a client, so every unexpected shape or setting must be
// refused before work starts.
describe('migration request checks', () => {
  it('accepts names and objects, and refuses anything unexpected', () => {
    const ok = parseMigrationRequest({
      source: 'a',
      target: 'b',
      collections: ['x', { from: 'y', to: 'z', fields: { a: 'b' } }],
    });
    assert.equal(ok.onConflict, 'skip');
    assert.equal(ok.batchSize, 100);
    assert.throws(
      () => parseMigrationRequest({ source: 'a', target: 'a' }),
      /different/,
    );
    assert.throws(
      () =>
        parseMigrationRequest({
          source: 'a',
          target: 'b',
          sql: 'drop table x',
        }),
      /Unknown setting/,
    );
    assert.throws(
      () =>
        parseMigrationRequest({
          source: 'a',
          target: 'b',
          onConflict: 'merge',
        }),
      /onConflict/,
    );
    assert.throws(
      () =>
        parseMigrationRequest({ source: 'a', target: 'b', batchSize: 100000 }),
      /batchSize/,
    );
    assert.throws(
      () =>
        parseMigrationRequest({
          source: 'a',
          target: 'b',
          collections: ['x; drop'],
        }),
      /plain name/,
    );
    assert.throws(
      () =>
        parseMigrationRequest({
          source: 'a',
          target: 'b',
          collections: ['x', 'x'],
        }),
      /twice/,
    );
    assert.throws(
      () =>
        parseMigrationRequest({
          source: 'a',
          target: 'b',
          collections: [
            { from: 'x', to: 'z' },
            { from: 'y', to: 'z' },
          ],
        }),
      /same|two collections/,
    );
  });

  // These answers decide whether a field mapping is allowed, warned about, or
  // blocked; a wrong yes would corrupt data silently.
  it('knows which types can hold each other', () => {
    assert.equal(typesCompatible('string', 'string'), 'same');
    assert.equal(typesCompatible('string', 'text'), 'check');
    assert.equal(typesCompatible('integer', 'decimal'), 'check');
    assert.equal(typesCompatible('decimal', 'integer'), 'no');
    assert.equal(typesCompatible('json', 'boolean'), 'no');
  });
});

// References are found by field flag or by relation, since adapters describe
// links differently; a wrong guess would leave dangling ids.
describe('finding references', () => {
  it('understands both a flag on the field and a foreign-key relation', () => {
    const parent = defineCollection(customers());
    const flagged = defineCollection(orders());
    const related = defineCollection({
      name: 'invoices',
      fields: [
        key(),
        { name: 'customer_id', type: 'integer' },
        { name: 'ref', type: 'string' },
      ],
      relations: [
        {
          name: 'customer_id_ref',
          target: 'customers',
          kind: 'many_to_one',
          mapping: { customer_id: 'id' },
        },
        {
          name: 'ref_ref',
          target: 'customers',
          kind: 'many_to_one',
          mapping: { ref: 'email' },
        },
      ],
    });
    const all = new Map([
      ['customers', parent],
      ['orders', flagged],
      ['invoices', related],
    ]);
    assert.equal(referenceOf(flagged, flagged.fields[1]!, all), 'customers');
    assert.equal(referenceOf(related, related.fields[1]!, all), 'customers');
    assert.equal(
      referenceOf(related, related.fields[2]!, all),
      undefined,
      'a link to a non-key column cannot be rewritten',
    );
  });
});

describe('migrating between connections', () => {
  // Core case: parents before children so references resolve, and reruns skip
  // existing rows so a retry cannot duplicate data.
  it('copies everything, in dependency order, and can be repeated safely', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await seeded(t);
      // Target lists orders first, to prove copy order comes from dependencies
      // and not declaration order.
      const target = await connect(t, 'New', [orders(), customers()]); // order differs on purpose

      const plan = await t.call('POST', '/v1/admin/migrations/plan', {
        body: { source, target },
      });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      assert.equal(plan.body.data.ready, true);
      assert.deepEqual(
        plan.body.data.collections.map((c: any) => c.from),
        ['customers', 'orders'],
        'parents are copied first',
      );
      assert.equal(plan.body.data.collections[0].sourceRecords.count, 2);
      assert.equal(
        (await records(t, target, 'customers')).length,
        0,
        'a plan writes nothing',
      );

      const start = await t.call('POST', '/v1/admin/migrations', {
        body: { source, target },
      });
      assert.equal(start.status, 202, JSON.stringify(start.body));
      const job = await finished(t, start.body.data.id);
      assert.equal(job.status, 'completed', JSON.stringify(job));
      assert.deepEqual(
        job.collections.map((c: any) => [
          c.created,
          c.failed,
          c.verified,
          c.differences,
        ]),
        [
          [2, 0, true, 0],
          [3, 0, true, 0],
        ],
      );

      const copied = await records(t, target, 'orders');
      assert.deepEqual(copied.map((r) => r.id).sort(), ['o1', 'o2', 'o3']);
      assert.equal(copied.find((r) => r.id === 'o1').total, 10.5);
      assert.equal(
        (await records(t, target, 'customers')).find((r) => r.id === 'c1')
          .email,
        'asha@example.com',
      );

      // Running again skips what is already there.
      const again = await finished(
        t,
        (
          await t.call('POST', '/v1/admin/migrations', {
            body: { source, target },
          })
        ).body.data.id,
      );
      assert.deepEqual(
        again.collections.map((c: any) => [c.created, c.skipped]),
        [
          [0, 2],
          [0, 3],
        ],
      );

      // Overwrite updates in place.
      const over = await finished(
        t,
        (
          await t.call('POST', '/v1/admin/migrations', {
            body: { source, target, onConflict: 'overwrite' },
          })
        ).body.data.id,
      );
      assert.deepEqual(
        over.collections.map((c: any) => [c.updated, c.created]),
        [
          [2, 0],
          [3, 0],
        ],
      );

      // The source was never changed.
      assert.equal((await records(t, source, 'orders')).length, 3);
      const audit = await t.call('GET', '/v1/admin/audit?limit=100');
      const ops = audit.body.data.map((e: any) => e.operation);
      assert.ok(
        ops.includes('migration.start') && ops.includes('migration.finish'),
      );
      const mine = audit.body.data.filter((e: any) =>
        e.operation.startsWith('migration'),
      );
      assert.equal(
        mine.length,
        6,
        'a start and a finish for each of the three runs',
      );
      assert.ok(
        !JSON.stringify(mine).includes('asha@example.com'),
        'record values stay out of migration audit entries',
      );
    } finally {
      await t.close();
    }
  });

  // When the target assigns ids, old ids are meaningless there, so foreign keys
  // must be rewritten or orders would point at the wrong customers.
  it('renumbers records when the target assigns ids, and rewrites references', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await seeded(t);
      const target = await connect(t, 'Numbered', [
        customers(key('id', 'integer', { generated: true })),
        orders(key('id', 'integer', { generated: true }), 'integer'),
      ]);
      const plan = await t.call('POST', '/v1/admin/migrations/plan', {
        body: { source, target },
      });
      assert.equal(plan.body.data.ready, true, JSON.stringify(plan.body.data));
      assert.equal(plan.body.data.collections[0].idsPreserved, false);

      const job = await finished(
        t,
        (
          await t.call('POST', '/v1/admin/migrations', {
            body: { source, target },
          })
        ).body.data.id,
      );
      assert.equal(job.status, 'completed', JSON.stringify(job));

      const newCustomers = await records(t, target, 'customers');
      const newOrders = await records(t, target, 'orders');
      assert.equal(newOrders.length, 3);
      const asha = newCustomers.find((c) => c.name === 'Asha');
      assert.equal(typeof asha.id, 'number');
      // Orders o1 and o3 belonged to c1 (Asha); their references must follow her new id.
      assert.equal(
        newOrders.filter((o) => o.customer_id === asha.id).length,
        2,
      );

      // A second run would duplicate everything, so it is refused.
      const second = await t.call('POST', '/v1/admin/migrations', {
        body: { source, target },
      });
      assert.equal(second.status, 409);
    } finally {
      await t.close();
    }
  });

  // Field and collection renames are applied consistently; the string to text
  // warning shows that lossy mappings are surfaced.
  it('renames fields and collections when asked', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await seeded(t);
      const target = await connect(t, 'Renamed', [
        {
          name: 'clients',
          fields: [
            key(),
            { name: 'full_name', type: 'string', required: true },
            { name: 'email', type: 'text' },
          ],
          relations: [],
        },
      ]);
      const body = {
        source,
        target,
        collections: [
          { from: 'customers', to: 'clients', fields: { name: 'full_name' } },
        ],
      };
      const plan = await t.call('POST', '/v1/admin/migrations/plan', { body });
      assert.equal(plan.body.data.ready, true, JSON.stringify(plan.body.data));
      assert.ok(
        plan.body.data.collections[0].warnings.some((w: string) =>
          /email/.test(w),
        ),
        'string to text is flagged',
      );
      const job = await finished(
        t,
        (await t.call('POST', '/v1/admin/migrations', { body })).body.data.id,
      );
      assert.equal(job.status, 'completed', JSON.stringify(job));
      assert.equal(
        (await records(t, target, 'clients')).find((r) => r.id === 'c2')
          .full_name,
        'Ravi',
      );
    } finally {
      await t.close();
    }
  });

  // The plan must block unsafe migrations up front and explain why, rather than
  // failing half way through.
  it('blocks a migration whose target does not fit, and says why', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await seeded(t);
      const noOrders = await connect(t, 'Partial', [customers()]);
      let plan = await t.call('POST', '/v1/admin/migrations/plan', {
        body: { source, target: noOrders },
      });
      assert.equal(plan.body.data.ready, false);
      assert.match(
        JSON.stringify(plan.body.data),
        /no collection called \\"orders\\"/,
      );
      const refused = await t.call('POST', '/v1/admin/migrations', {
        body: { source, target: noOrders },
      });
      assert.equal(refused.status, 400);

      const mismatched = await connect(t, 'Mismatch', [
        {
          name: 'customers',
          fields: [
            key(),
            { name: 'name', type: 'boolean', required: true },
            { name: 'extra', type: 'string', required: true },
          ],
          relations: [],
        },
      ]);
      plan = await t.call('POST', '/v1/admin/migrations/plan', {
        body: { source, target: mismatched, collections: ['customers'] },
      });
      const text = JSON.stringify(plan.body.data.collections[0].problems);
      assert.match(text, /cannot hold each other/);
      assert.match(text, /requires \\"extra\\"/);
      assert.match(text, /Not copied, no matching target field: email/);

      // Leaving fields behind is allowed only when asked for.
      const lean = await connect(t, 'Lean', [
        {
          name: 'customers',
          fields: [key(), { name: 'name', type: 'string', required: true }],
          relations: [],
        },
      ]);
      plan = await t.call('POST', '/v1/admin/migrations/plan', {
        body: { source, target: lean, collections: ['customers'] },
      });
      assert.equal(plan.body.data.ready, false);
      plan = await t.call('POST', '/v1/admin/migrations/plan', {
        body: {
          source,
          target: lean,
          collections: ['customers'],
          dropUnmappedFields: true,
        },
      });
      assert.equal(plan.body.data.ready, true);
    } finally {
      await t.close();
    }
  });

  // Writing into a read-only connection would bypass its protection, and
  // migration is an admin-only operation.
  it('refuses a read-only target and non-administrators', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await seeded(t);
      const locked = await connect(
        t,
        'Locked',
        [customers(), orders()],
        'read_only',
      );
      const refused = await t.call('POST', '/v1/admin/migrations', {
        body: { source, target: locked },
      });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error.code, 'READ_ONLY');

      const editor = await tokenFor(t, 'editor');
      for (const [method, path] of [
        ['POST', '/v1/admin/migrations/plan'],
        ['POST', '/v1/admin/migrations'],
        ['GET', '/v1/admin/migrations'],
      ] as const) {
        const r = await t.call(method, path, {
          token: editor,
          ...(method === 'POST' ? { body: { source, target: locked } } : {}),
        });
        assert.equal(r.status, 403, path);
      }
      assert.equal(
        (await t.call('GET', '/v1/admin/migrations/mig_missing')).status,
        404,
      );
    } finally {
      await t.close();
    }
  });

  // One bad row must not abort the job, and its error output must never contain
  // the offending value.
  it('reports bad records without leaking their values, and carries on', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await connect(t, 'Messy', [
        {
          name: 'notes',
          fields: [key(), { name: 'body', type: 'string' }],
          relations: [],
        },
      ]);
      for (const id of ['n1', 'n2', 'n3']) {
        await add(t, source, 'notes', {
          id,
          body: id === 'n2' ? 'x'.repeat(50) + 'SECRET-VALUE' : 'ok',
        });
      }
      const target = await connect(t, 'Strict', [
        {
          name: 'notes',
          fields: [
            key(),
            { name: 'body', type: 'string', validation: { maxLength: 10 } },
          ],
          relations: [],
        },
      ]);

      const job = await finished(
        t,
        (
          await t.call('POST', '/v1/admin/migrations', {
            body: { source, target },
          })
        ).body.data.id,
      );
      assert.equal(job.status, 'completed_with_errors');
      assert.deepEqual(
        [job.collections[0].created, job.collections[0].failed],
        [2, 1],
      );
      assert.equal(job.errors[0].id, 'n2');
      assert.equal(job.errors[0].code, 'VALIDATION_FAILED');
      assert.ok(!JSON.stringify(job).includes('SECRET-VALUE'));
      const audit = (
        await t.call('GET', '/v1/admin/audit?limit=100')
      ).body.data.filter((e: any) => e.operation.startsWith('migration'));
      assert.equal(audit.length, 2);
      assert.ok(!JSON.stringify(audit).includes('SECRET-VALUE'));
    } finally {
      await t.close();
    }
  });

  // A systematically bad migration should stop early instead of running to the
  // end; finished jobs cannot be cancelled.
  it('stops after too many errors and can be cancelled only while running', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await connect(t, 'Many', [
        {
          name: 'notes',
          fields: [key(), { name: 'body', type: 'string' }],
          relations: [],
        },
      ]);
      for (let i = 0; i < 12; i += 1) {
        await add(t, source, 'notes', {
          id: `n${i}`,
          body: 'way too long for the target',
        });
      }
      const target = await connect(t, 'Tiny', [
        {
          name: 'notes',
          fields: [
            key(),
            { name: 'body', type: 'string', validation: { maxLength: 3 } },
          ],
          relations: [],
        },
      ]);
      const job = await finished(
        t,
        (
          await t.call('POST', '/v1/admin/migrations', {
            body: { source, target, maxErrors: 4 },
          })
        ).body.data.id,
      );
      assert.equal(job.status, 'failed');
      assert.match(job.message, /Stopped after 4 errors/);
      assert.ok(job.collections[0].failed <= 5);

      assert.equal(
        (await t.call('POST', `/v1/admin/migrations/${job.id}/cancel`)).status,
        409,
      );
    } finally {
      await t.close();
    }
  });

  // Operators watch these counters to track progress and failures.
  it('counts migrated records in the metrics', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const source = await seeded(t);
      const target = await connect(t, 'Counted', [customers(), orders()]);
      await finished(
        t,
        (
          await t.call('POST', '/v1/admin/migrations', {
            body: { source, target },
          })
        ).body.data.id,
      );
      assert.match(
        t.gateway.services.metrics.text(),
        /sethucms_migration_records_total\{result="created"\} 5/,
      );
    } finally {
      await t.close();
    }
  });
});
