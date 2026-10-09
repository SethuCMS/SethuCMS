// Covers the change feed and webhooks - sequence numbering, ids-only payloads,
// signed delivery, retries, redirect and SSRF handling, and persistence.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  DeliveryWorker,
  matchesWebhook,
  payloadFor,
  sign,
} from '../src/changes/worker.js';
import { MemoryChangeStore } from '../src/changes/store.js';
import { silentLogger } from '../src/logger.js';
import { NetworkGuard } from '../src/security/network-guard.js';
import { Vault } from '../src/security/vault.js';
import type { StoredWebhook } from '../src/store/state.js';
import {
  ADMIN_TOKEN,
  demoConnection,
  startGateway,
  tokenFor,
  type TestGateway,
} from './helpers.js';

interface Hit {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A webhook receiver that records what it is sent and answers with whatever `answer` says. */
class Receiver {
  server!: Server;
  url = '';
  hits: Hit[] = [];
  answers: number[] = [];
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        this.hits.push({ headers: req.headers, body });
        res.writeHead(this.answers.shift() ?? 200).end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}/hook`;
  }
  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// Polling helper - delivery is asynchronous, so tests wait for the condition
// instead of sleeping a fixed time.
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  read: () => T | undefined | false | Promise<T | undefined | false>,
  what: string,
): Promise<T> {
  for (let i = 0; i < 80; i += 1) {
    const value = await read();
    if (value) {
      return value;
    }
    await wait(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('change feed', () => {
  let t: TestGateway;
  let connection: string;
  before(async () => {
    t = await startGateway();
    connection = await demoConnection(t);
  });
  after(async () => {
    await t.close();
  });

  const records = () =>
    `/v1/connections/${connection}/collections/authors/records`;

  // Clients resume by sequence number, so numbers must increase, be resumable,
  // and carry ids only so data cannot leak past field permissions.
  it('numbers every change, resumes from a number, and carries ids only', async () => {
    const start = (await t.call('GET', '/v1/changes')).body.head as number;
    const created = await t.call('POST', records(), {
      body: { name: 'Feed Author', email: 'secret@example.com' },
    });
    const id = created.body.data.id;
    await t.call('PATCH', `${records()}/${id}`, {
      body: { bio: 'changed bio text' },
    });
    await t.call('DELETE', `${records()}/${id}`);

    const feed = await until(async () => {
      const page = (await t.call('GET', `/v1/changes?since=${start}`)).body;
      return page.data.length >= 3 ? page : undefined;
    }, 'three events in the feed');
    assert.deepEqual(
      feed.data.map((e: any) => e.type),
      ['record.created', 'record.updated', 'record.deleted'],
    );
    assert.ok(
      feed.data[0].seq > start &&
        feed.data[1].seq > feed.data[0].seq &&
        feed.data[2].seq > feed.data[1].seq,
    );
    assert.equal(feed.data[0].recordId, String(id));
    const text = JSON.stringify(feed);
    assert.ok(
      !text.includes('secret@example.com') &&
        !text.includes('changed bio text'),
      'no field values in the feed',
    );

    // Resume after the first event: only the later two come back.
    const resumed = (
      await t.call('GET', `/v1/changes?since=${feed.data[0].seq}`)
    ).body;
    assert.deepEqual(
      resumed.data.map((e: any) => e.type),
      ['record.updated', 'record.deleted'],
    );
    assert.equal(resumed.next, feed.data[2].seq);
    assert.equal(resumed.gap, false);
  });

  // Malformed paging parameters must be rejected, not coerced, and the feed is
  // never public.
  it('rejects bad parameters and requires a token', async () => {
    assert.equal((await t.call('GET', '/v1/changes?since=abc')).status, 400);
    assert.equal((await t.call('GET', '/v1/changes?limit=0')).status, 400);
    assert.equal(
      (await t.call('GET', '/v1/changes', { token: null })).status,
      401,
    );
  });

  // The feed is filtered by what the caller may read, or it would reveal
  // activity in collections they cannot see.
  it('hides events about collections the caller may not read', async () => {
    const viewer = await tokenFor(t, 'viewer');
    // connection.changed events have no collection, so only an admin sees them.
    const before = (await t.call('GET', '/v1/changes', { token: viewer })).body;
    assert.ok(
      before.data.every((e: any) => 'collection' in e),
      'a viewer only gets content events',
    );
  });
});

describe('webhooks', () => {
  let t: TestGateway;
  let connection: string;
  const receiver = new Receiver();
  before(async () => {
    await receiver.start();
    t = await startGateway();
    connection = await demoConnection(t);
  });
  after(async () => {
    await t.close();
    await receiver.stop();
  });

  // Signing proves a payload came from the gateway; the secret must be shown
  // once, on creation only.
  it('delivers signed events, and the secret is shown only once', async () => {
    const created = await t.call('POST', '/v1/admin/webhooks', {
      body: { name: 'Receiver', url: receiver.url, events: ['record.created'] },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { id, secret } = created.body.data as { id: string; secret: string };
    assert.ok(secret.startsWith('whsec_'));

    const listed = JSON.stringify(
      (await t.call('GET', '/v1/admin/webhooks')).body,
    );
    assert.ok(!listed.includes(secret), 'the list never shows the secret');

    await t.call(
      'POST',
      `/v1/connections/${connection}/collections/authors/records`,
      { body: { name: 'Hooked' } },
    );
    const hit = await until(
      () => receiver.hits[0],
      'the receiver to get the event',
    );
    const body = JSON.parse(hit.body);
    assert.equal(body.type, 'record.created');
    assert.equal(body.connectionId, connection);
    assert.match(body.id, /^evt_\d+$/);
    assert.ok(!hit.body.includes('Hooked'), 'no field values in the payload');

    // The receiver can check the signature with the secret it was given.
    const header = String(hit.headers['x-sethu-signature']);
    const [t0, v1] = [
      /t=(\d+)/.exec(header)?.[1],
      /v1=([0-9a-f]{64})/.exec(header)?.[1],
    ];
    assert.ok(t0 && v1);
    assert.equal(
      createHmac('sha256', secret).update(`${t0}.${hit.body}`).digest('hex'),
      v1,
    );
    assert.equal(hit.headers['x-sethu-event'], 'record.created');

    const delivered = await until(async () => {
      const list = (await t.call('GET', `/v1/admin/webhooks/${id}/deliveries`))
        .body.data as Array<{ status: string }>;
      return list.length > 0 && list.every((d) => d.status === 'delivered')
        ? list
        : undefined;
    }, 'delivery marked delivered');
    assert.equal(delivered.length, 1);
  });

  // Subscribers must receive only the events they chose, or they get data they
  // never asked for.
  it('only sends the event types it was asked for', async () => {
    const before = receiver.hits.length;
    // The webhook above asked only for record.created: an update must not be sent.
    const created = await t.call(
      'POST',
      `/v1/connections/${connection}/collections/authors/records`,
      { body: { name: 'Second' } },
    );
    await until(
      () => receiver.hits.length > before,
      'second creation delivered',
    );
    const count = receiver.hits.length;
    await t.call(
      'PATCH',
      `/v1/connections/${connection}/collections/authors/records/${created.body.data.id}`,
      { body: { bio: 'x' } },
    );
    await wait(400);
    assert.equal(receiver.hits.length, count);
  });

  // Disabling must really stop deliveries, and webhook management is admin-only
  // because URLs are outbound request targets.
  it('can be switched off and deleted, and administrators only', async () => {
    const list = (await t.call('GET', '/v1/admin/webhooks')).body
      .data as Array<{ id: string }>;
    const id = list[0]!.id;
    const editor = await tokenFor(t, 'editor');
    assert.equal(
      (await t.call('GET', '/v1/admin/webhooks', { token: editor })).status,
      403,
    );
    assert.equal(
      (
        await t.call('POST', '/v1/admin/webhooks', {
          token: editor,
          body: { name: 'x', url: receiver.url },
        })
      ).status,
      403,
    );

    assert.equal(
      (
        await t.call('PATCH', `/v1/admin/webhooks/${id}`, {
          body: { active: false },
        })
      ).body.data.active,
      false,
    );
    const before = receiver.hits.length;
    await t.call(
      'POST',
      `/v1/connections/${connection}/collections/authors/records`,
      { body: { name: 'While off' } },
    );
    await wait(400);
    assert.equal(
      receiver.hits.length,
      before,
      'nothing is sent while it is off',
    );

    assert.equal(
      (await t.call('DELETE', `/v1/admin/webhooks/${id}`)).status,
      204,
    );
    assert.equal(
      (await t.call('DELETE', `/v1/admin/webhooks/${id}`)).status,
      404,
    );
  });

  // Webhook URLs are outbound request targets, so each unsafe form is rejected
  // (credentials in URLs, non-http schemes, metadata addresses, unknown
  // events).
  it('refuses bad addresses and unknown event types', async () => {
    const bad = async (body: Record<string, unknown>) =>
      (
        await t.call('POST', '/v1/admin/webhooks', {
          body: { name: 'x', ...body },
        })
      ).status;
    assert.equal(await bad({ url: 'not a url' }), 400);
    assert.equal(await bad({ url: 'ftp://example.com/hook' }), 400);
    assert.equal(await bad({ url: 'http://user:pass@127.0.0.1:9/hook' }), 400);
    assert.equal(
      await bad({ url: 'http://169.254.169.254/latest/meta-data' }),
      400,
      'the cloud metadata address is always blocked',
    );
    assert.equal(
      await bad({ url: receiver.url, events: ['record.exploded'] }),
      400,
    );
    assert.equal(
      await bad({ url: receiver.url, collection: 'authors' }),
      400,
      'a collection filter needs a connection',
    );
  });

  // The audit log shows who changed a webhook but must never hold its signing
  // secret.
  it('is audited without the secret', async () => {
    const entries = JSON.stringify(
      (await t.call('GET', '/v1/admin/audit?limit=300')).body,
    );
    assert.ok(entries.includes('webhook.create'));
    assert.ok(!entries.includes('whsec_'));
  });
});

describe('webhooks outside production rules', () => {
  // Strict mode blocks private targets (SSRF), and production forbids plain
  // http so signed payloads are not sent in clear text.
  it('refuses private addresses when private networks are not allowed, and plain http in production', async () => {
    const strict = await startGateway({ allowPrivateNetworks: false });
    assert.equal(
      (
        await strict.call('POST', '/v1/admin/webhooks', {
          body: { name: 'x', url: 'http://127.0.0.1:9/hook' },
        })
      ).status,
      400,
    );
    await strict.close();

    const production = await startGateway(
      { production: true, seedDemo: false },
      {
        env: {
          SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
          SETHUCMS_VAULT_KEY: Buffer.alloc(32, 1).toString('base64'),
          SETHUCMS_CURSOR_SECRET: Buffer.alloc(32, 2).toString('base64'),
          SETHUCMS_PREVIEW_SECRET: Buffer.alloc(32, 3).toString('base64'),
        },
      },
    );
    const refused = await production.call('POST', '/v1/admin/webhooks', {
      body: { name: 'x', url: 'http://example.com/hook' },
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error.message, /https/);
    await production.close();
  });
});

// Delivery worker tests call tick() directly with short backoff, so retry logic
// is exercised deterministically.
describe('delivery worker', () => {
  const vault = new Vault(Buffer.alloc(32, 9));
  const receiver = new Receiver();
  before(async () => {
    await receiver.start();
  });
  after(async () => {
    await receiver.stop();
  });

  const webhook = (
    url: string,
    extra: Partial<StoredWebhook> = {},
  ): StoredWebhook => ({
    id: 'wh_test',
    name: 't',
    url,
    secret: vault.encrypt('whsec_unit', 'webhook:wh_test'),
    events: ['*'],
    active: true,
    createdAt: new Date().toISOString(),
    createdBy: 'x',
    ...extra,
  });
  const event = {
    type: 'record.created',
    connectionId: 'c1',
    collection: 'authors',
    recordId: '1',
  } as const;
  const make = (hooks: Record<string, StoredWebhook>, backoff = [0]) => {
    const store = new MemoryChangeStore();
    const worker = new DeliveryWorker({
      store,
      webhooks: () => hooks,
      vault,
      guard: new NetworkGuard({ allowPrivateNetworks: true }),
      logger: silentLogger,
      backoffSeconds: backoff,
    });
    return { store, worker };
  };

  // Transient 5xx responses must be retried until the receiver recovers,
  // without losing the event.
  it('retries a failing receiver and then delivers', async () => {
    receiver.hits = [];
    receiver.answers = [500, 503];
    const { store, worker } = make({ wh_test: webhook(receiver.url) });
    await store.append(event, ['wh_test']);
    for (let i = 0; i < 5; i += 1) {
      await worker.tick();
      await wait(5);
    }
    assert.equal(receiver.hits.length, 3);
    const [delivery] = await store.deliveries('wh_test', 5);
    assert.equal(delivery?.status, 'delivered');
    assert.equal(delivery?.attempts, 3);
    // Every attempt carries the same delivery id, so a receiver can drop repeats.
    assert.equal(
      new Set(receiver.hits.map((h) => h.headers['x-sethu-delivery'])).size,
      1,
    );
  });

  // Retries must stop at a bounded count, or a dead receiver would be hit
  // forever.
  it('gives up after the last attempt and says so', async () => {
    receiver.hits = [];
    receiver.answers = Array(20).fill(500);
    const { store, worker } = make({ wh_test: webhook(receiver.url) });
    await store.append(event, ['wh_test']);
    for (let i = 0; i < 12; i += 1) {
      await worker.tick();
      await wait(5);
    }
    const [delivery] = await store.deliveries('wh_test', 5);
    assert.equal(delivery?.status, 'dead');
    assert.equal(delivery?.attempts, 8);
    assert.equal(delivery?.lastStatus, 500);
    assert.equal(receiver.hits.length, 8, 'no attempts after giving up');
  });

  // Following a redirect would turn a public URL into an SSRF vector, and a
  // stored response body could leak data from the receiver.
  it("does not follow redirects and never stores the receiver's answer", async () => {
    const redirector = createServer((_req, res) =>
      res
        .writeHead(302, { Location: 'http://127.0.0.1:1/' })
        .end('<secret-in-body>'),
    );
    await new Promise<void>((resolve) =>
      redirector.listen(0, '127.0.0.1', resolve),
    );
    const url = `http://127.0.0.1:${(redirector.address() as { port: number }).port}/`;
    const { store, worker } = make({ wh_test: webhook(url) }, [3600]);
    await store.append(event, ['wh_test']);
    await worker.tick();
    const [delivery] = await store.deliveries('wh_test', 1);
    assert.equal(delivery?.lastStatus, 302);
    assert.ok(!JSON.stringify(delivery).includes('secret-in-body'));
    redirector.closeAllConnections();
    await new Promise<void>((resolve) => redirector.close(() => resolve()));
  });

  // Deliveries to a deleted webhook or a blocked address must not retry
  // forever; the blocked address must never be contacted.
  it('stops for a deleted webhook, and for a blocked address', async () => {
    const gone = make({});
    await gone.store.append(event, ['wh_missing']);
    await gone.worker.tick();
    assert.equal(
      (await gone.store.deliveries('wh_missing', 1))[0]?.status,
      'dead',
    );

    const blocked = make(
      { wh_test: webhook('http://169.254.169.254/latest') },
      [3600],
    );
    await blocked.store.append(event, ['wh_test']);
    receiver.hits = [];
    await blocked.worker.tick();
    assert.equal(
      (await blocked.store.deliveries('wh_test', 1))[0]?.attempts,
      1,
    );
    assert.equal(receiver.hits.length, 0);
  });

  // Routing rules decide who receives an event; an over-broad match would send
  // events to the wrong subscribers.
  it('matches events to webhooks by type, connection and collection', () => {
    assert.equal(
      matchesWebhook(
        webhook('http://x', { events: ['record.updated'] }),
        event,
      ),
      false,
    );
    assert.equal(
      matchesWebhook(webhook('http://x', { connectionId: 'other' }), event),
      false,
    );
    assert.equal(
      matchesWebhook(
        webhook('http://x', { connectionId: 'c1', collection: 'articles' }),
        event,
      ),
      false,
    );
    assert.equal(
      matchesWebhook(
        webhook('http://x', { connectionId: 'c1', collection: 'authors' }),
        event,
      ),
      true,
    );
    assert.equal(
      matchesWebhook(webhook('http://x', { active: false }), event),
      false,
    );
    assert.equal(
      matchesWebhook(webhook('http://x'), {
        type: 'connection.changed',
        connectionId: 'c1',
      }),
      true,
    );
  });

  // The signature format is a public contract that receivers implement, so a
  // change would break their verification.
  it('signs as documented', () => {
    const body = payloadFor(7, '2026-01-01T00:00:00.000Z', event);
    assert.equal(
      sign('s', 100, body),
      `t=100,v1=${createHmac('sha256', 's').update(`100.${body}`).digest('hex')}`,
    );
    assert.deepEqual(JSON.parse(body), {
      id: 'evt_7',
      seq: 7,
      at: '2026-01-01T00:00:00.000Z',
      ...event,
    });
  });
});

// Sequence numbers must continue after a restart; reused numbers would make
// clients skip or repeat events.
describe('change feed survives a restart (file storage)', () => {
  it('keeps the numbers going', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-feed-'));
    try {
      const first = await startGateway({ dataDir: dir, seedDemo: true });
      const id = await demoConnection(first);
      await first.call(
        'POST',
        `/v1/connections/${id}/collections/authors/records`,
        { body: { name: 'Before restart' } },
      );
      const head = await until(async () => {
        const h = (await first.call('GET', '/v1/changes')).body.head as number;
        return h > 0 ? h : undefined;
      }, 'a change to be recorded');
      await first.close();

      const second = await startGateway({ dataDir: dir, seedDemo: true });
      const after = (await second.call('GET', '/v1/changes')).body;
      assert.ok(after.head >= head, 'the feed was kept');
      await second.call(
        'POST',
        `/v1/connections/${await demoConnection(second)}/collections/authors/records`,
        { body: { name: 'After restart' } },
      );
      const later = await until(async () => {
        const h = (await second.call('GET', '/v1/changes')).body.head as number;
        return h > after.head ? h : undefined;
      }, 'numbers to continue');
      assert.ok(later > head);
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
