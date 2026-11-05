/**
 * Scheduled publish with two gateways on one PostgreSQL state: a due draft must
 * be published by exactly one of them. Skipped unless SETHUCMS_TEST_PG_HOST is set.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ADMIN_TOKEN, demoConnection, startGateway, type TestGateway } from './helpers.js';

const env = process.env;
const live = Boolean(env['SETHUCMS_TEST_PG_HOST']);
const DB = `sethucms_sched_${randomBytes(3).toString('hex')}`;
const user = encodeURIComponent(env['SETHUCMS_TEST_PG_USER'] ?? 'postgres');
const password = env['SETHUCMS_TEST_PG_PASSWORD'] ? ':' + encodeURIComponent(env['SETHUCMS_TEST_PG_PASSWORD']) : '';
const urlFor = (database: string): string =>
  `postgres://${user}${password}@${env['SETHUCMS_TEST_PG_HOST']}:${env['SETHUCMS_TEST_PG_PORT'] ?? 5432}/${database}`;
const secrets = {
  SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
  SETHUCMS_VAULT_KEY: randomBytes(32).toString('base64'),
  SETHUCMS_CURSOR_SECRET: randomBytes(32).toString('base64'),
  SETHUCMS_PREVIEW_SECRET: randomBytes(32).toString('base64'),
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('scheduled publish with two gateways (live PostgreSQL)', { skip: live ? false : 'set SETHUCMS_TEST_PG_HOST to run' }, () => {
  let admin: any;
  let a: TestGateway;
  let b: TestGateway;

  before(async () => {
    const driver = 'pg';
    const { default: pg } = (await import(driver)) as { default: any };
    admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${DB}`);
    const options = { seedDemo: true, stateUrl: urlFor(DB), statePollMs: 100, dataDir: undefined };
    a = await startGateway(options, { env: secrets });
    b = await startGateway(options, { env: secrets });
  });
  after(async () => {
    await a?.close();
    await b?.close();
    await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    await admin?.end();
  });

  it('publishes a due draft once, even though both gateways look for it', async () => {
    const id = await demoConnection(a);
    const base = `/v1/connections/${id}/collections/articles`;
    const made = await a.call('POST', `${base}/drafts`, { body: { recordId: 3, values: { title: 'Once only' } } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const draftId = made.body.data.id as string;
    const set = await a.call('PUT', `${base}/drafts/${draftId}/schedule`, { body: { publishAt: new Date(Date.now() + 3_600_000).toISOString() } });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    // Let B see the schedule, then make both gateways check at the same moment.
    await wait(500);
    const later = Date.now() + 2 * 3_600_000;
    const [x, y] = await Promise.all([a.gateway.services.drafts.runDue(later), b.gateway.services.drafts.runDue(later)]);
    assert.equal(x + y, 1, `published by both or neither: ${x} + ${y}`);

    await wait(500);
    for (const t of [a, b]) {
      const draft = await t.call('GET', `${base}/drafts/${draftId}`);
      assert.equal(draft.body.data.status, 'published');
      assert.equal(draft.body.data.scheduleError, undefined, 'the loser must not record a failure');
    }
  });
});
