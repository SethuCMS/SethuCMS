/**
 * A separate worker process delivering webhooks for two gateways that share state
 * through a real PostgreSQL. Skipped unless SETHUCMS_TEST_PG_HOST is set.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { ADMIN_TOKEN, startGateway, type TestGateway } from './helpers.js';

const env = process.env;
const live = Boolean(env['SETHUCMS_TEST_PG_HOST']);
const DB = `sethucms_worker_${randomBytes(3).toString('hex')}`;
const credentials = `${encodeURIComponent(env['SETHUCMS_TEST_PG_USER'] ?? 'postgres')}${env['SETHUCMS_TEST_PG_PASSWORD'] ? ':' + encodeURIComponent(env['SETHUCMS_TEST_PG_PASSWORD']) : ''}`;
const urlFor = (database: string): string =>
  `postgres://${credentials}@${env['SETHUCMS_TEST_PG_HOST']}:${env['SETHUCMS_TEST_PG_PORT'] ?? 5432}/${database}`;
const secrets = {
  SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
  SETHUCMS_VAULT_KEY: randomBytes(32).toString('base64'),
  SETHUCMS_CURSOR_SECRET: randomBytes(32).toString('base64'),
  SETHUCMS_PREVIEW_SECRET: randomBytes(32).toString('base64'),
};
// The worker runs as a real child process, as it would in production.
const WORKER = fileURLToPath(new URL('../src/worker.js', import.meta.url));
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe(
  'a standalone worker with shared state (live PostgreSQL)',
  { skip: live ? false : 'set SETHUCMS_TEST_PG_HOST to run' },
  () => {
    let admin: any;
    let a: TestGateway;
    let b: TestGateway;
    let worker: ChildProcess;
    let receiver: Server;
    let receiverUrl = '';
    const received: string[] = [];

    before(async () => {
      const driver = 'pg';
      const { default: pg } = (await import(driver)) as { default: any };
      admin = new pg.Client({ connectionString: urlFor('postgres') });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${DB}`);

      // Local receiver stands in for the customer's webhook endpoint.
      receiver = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          received.push(body);
          res.writeHead(200).end();
        });
      });
      await new Promise<void>((resolve) =>
        receiver.listen(0, '127.0.0.1', resolve),
      );
      receiverUrl = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`;

      // The gateways do NOT deliver; only the worker process does.
      const options = {
        seedDemo: false,
        stateUrl: urlFor(DB),
        statePollMs: 200,
        worker: false,
      };
      a = await startGateway(options, { env: secrets });
      b = await startGateway(options, { env: secrets });
      worker = spawn(process.execPath, [WORKER], {
        stdio: ['ignore', 'ignore', 'inherit'],
        env: {
          ...process.env,
          ...secrets,
          NODE_ENV: 'development',
          SETHUCMS_STATE_URL: urlFor(DB),
          SETHUCMS_STATE_POLL_MS: '200',
          SETHUCMS_ALLOW_PRIVATE_NETWORKS: 'true',
          SETHUCMS_LOG_LEVEL: 'error',
        },
      });
    });

    after(async () => {
      worker?.kill('SIGTERM');
      await a?.close();
      await b?.close();
      await new Promise<void>((resolve) => {
        receiver?.closeAllConnections();
        receiver?.close(() => resolve());
      });
      await admin
        ?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
        .catch(() => undefined);
      await admin?.end();
    });

    // Exactly-once matters: duplicate webhooks cause double side effects for
    // customers, and with shared state several processes could race to send.
    it('delivers an event made on gateway B for a webhook created on gateway A, exactly once', async () => {
      const connection = await a.call('POST', '/v1/admin/connections', {
        body: {
          name: 'Hooked',
          adapter: 'memory',
          mode: 'read_write',
          expose: 'all',
        },
      });
      const connectionId = connection.body.data.id as string;
      const hook = await a.call('POST', '/v1/admin/webhooks', {
        body: {
          name: 'Worker test',
          url: receiverUrl,
          events: ['record.created'],
        },
      });
      assert.equal(hook.status, 201, JSON.stringify(hook.body));
      // Let gateway B learn about the webhook.
      for (
        let i = 0;
        i < 40 &&
        (await b.call('GET', '/v1/admin/webhooks')).body.data.length === 0;
        i += 1
      ) {
        await wait(100);
      }

      const created = await b.call(
        'POST',
        `/v1/connections/${connectionId}/collections/authors/records`,
        { body: { name: 'Delivered by the worker' } },
      );
      assert.equal(created.status, 201, JSON.stringify(created.body));

      for (let i = 0; i < 100 && received.length === 0; i += 1) {
        await wait(100);
      }
      assert.equal(received.length, 1, 'the worker delivered the event');
      assert.equal(JSON.parse(received[0] as string).type, 'record.created');

      await wait(1500); // a second delivery would show up by now
      assert.equal(
        received.length,
        1,
        'delivered once, not once per gateway or worker',
      );

      const deliveries = (
        await a.call(
          'GET',
          `/v1/admin/webhooks/${hook.body.data.id}/deliveries`,
        )
      ).body.data as Array<{ status: string }>;
      assert.deepEqual(
        deliveries.map((d) => d.status),
        ['delivered'],
      );
    });

    // Sequence numbers let clients resume without gaps or repeats, even when
    // two gateways write.
    it('the shared change feed holds events from both gateways in one order', async () => {
      const connection = (await a.call('GET', '/v1/connections')).body.data[0]
        .id as string;
      await a.call(
        'POST',
        `/v1/connections/${connection}/collections/authors/records`,
        { body: { name: 'From A' } },
      );
      await b.call(
        'POST',
        `/v1/connections/${connection}/collections/authors/records`,
        { body: { name: 'From B' } },
      );
      let feed: any[] = [];
      for (let i = 0; i < 50; i += 1) {
        feed = (
          await a.call('GET', '/v1/changes?since=0&limit=500')
        ).body.data.filter((e: any) => e.type === 'record.created');
        if (feed.length >= 3) {
          break;
        }
        await wait(100);
      }
      assert.ok(feed.length >= 3);
      const seqs = feed.map((e) => e.seq as number);
      assert.deepEqual(
        seqs,
        [...seqs].sort((x, y) => x - y),
      );
      assert.equal(new Set(seqs).size, seqs.length, 'no number is used twice');
    });
  },
);
