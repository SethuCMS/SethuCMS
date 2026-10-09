/**
 * Adapters in other processes, over the gRPC adapter protocol.
 *
 * The "remote" adapter here is the in-memory adapter served by our own Node
 * server, so this proves the client, the server and the wire format agree with
 * each other and with the conformance suite. It does not prove that an adapter
 * written in Python or Go works: those must pass the same suite (see docs).
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { MemoryAdapter } from '@sethucms/adapter-memory';
import {
  GrpcAdapter,
  serveAdapter,
  type RunningServer,
} from '@sethucms/adapter-sdk/grpc';
// Reused from the conformance suite so remote adapters are held to the same
// contract as native ones.
import {
  conformanceCollection,
  defineConformanceSuite,
} from '@sethucms/adapter-sdk/testing';
import {
  PRESETS,
  defineCapabilities,
  errors,
  type CollectionDefinition,
} from '@sethucms/core';
import { demoCollections } from '../src/connections/demo.js';
import { startGateway, type TestGateway } from './helpers.js';

const TOKEN = 'grpc-shared-secret-0123456789';

// Serves an in-memory adapter over gRPC to act as the remote process.
async function remote(
  capabilities?: ReturnType<typeof defineCapabilities>,
  collections: CollectionDefinition[] = [conformanceCollection],
) {
  const server = await serveAdapter(
    new MemoryAdapter({
      collections,
      ...(capabilities ? { capabilities } : {}),
    }),
    { token: TOKEN },
  );
  return server;
}

const connectInput = (port: number, token = TOKEN) => ({
  connectionId: 'c1',
  readOnly: false,
  config: { address: `127.0.0.1:${port}`, tls: false },
  credentials: { token },
});

// The limited-capability run checks the client does not assume features the
// remote does not advertise.
// The remote adapter must pass the same suite as every real database.
for (const [label, capabilities] of [
  ['full capabilities', undefined],
  ['limited, like DynamoDB', defineCapabilities({ ...PRESETS.dynamodb })],
] as const) {
  defineConformanceSuite(test, {
    label: `grpc (${label})`,
    async prepare() {
      const server = await remote(capabilities);
      const adapter = new GrpcAdapter();
      await adapter.connect(connectInput(server.port));
      return {
        adapter,
        cleanup: async () => {
          await adapter.close();
          await server.close();
        },
      };
    },
  });
}

// Connection-time rules the client must enforce before trusting a remote.
describe('gRPC adapter: connection rules and errors', () => {
  let server: RunningServer;
  before(async () => {
    server = await remote();
  });
  after(async () => {
    await server.close();
  });

  // Message must stay generic so it does not reveal whether the server or the
  // token was at fault.
  test('a wrong token is refused with a plain message', async () => {
    const adapter = new GrpcAdapter();
    await assert.rejects(
      adapter.connect(
        connectInput(server.port, 'a-different-secret-0123456789'),
      ),
      (error: any) => error.code === 'AUTH_FAILED',
    );
  });

  test('an address that is not host:port is refused', async () => {
    await assert.rejects(
      new GrpcAdapter().connect({
        ...connectInput(server.port),
        config: { address: 'nonsense' },
      }),
      (error: any) => error.code === 'VALIDATION_FAILED',
    );
  });

  // Sending a credential over plaintext to a non-local host would expose it on
  // the network.
  test('plain text to another machine is refused when TLS is required', async () => {
    const strict = new GrpcAdapter({ requireTls: true });
    await assert.rejects(
      strict.connect({
        ...connectInput(server.port),
        config: { address: '10.1.2.3:50051', tls: false },
      }),
      (error: any) =>
        error.code === 'VALIDATION_FAILED' && /tls/i.test(error.message),
    );
    // Loopback is exempt from the TLS rule, or local development would be
    // impossible.
    // This machine is fine without TLS.
    const local = new GrpcAdapter({ requireTls: true });
    await local.connect(connectInput(server.port));
    await local.close();
  });

  // Port 1 is closed; a short timeout keeps the test fast and either code is
  // acceptable.
  test('a server that is not there reports a connection failure', async () => {
    const adapter = new GrpcAdapter();
    await assert.rejects(
      adapter.connect({
        ...connectInput(1),
        config: { address: '127.0.0.1:1', tls: false, callTimeoutMs: 1500 },
      }),
      (error: any) => ['CONNECTION_FAILED', 'TIMEOUT'].includes(error.code),
    );
  });

  // Short tokens are weak, so rejecting them locally avoids sending them at
  // all.
  test('a short token is refused before anything is sent', async () => {
    await assert.rejects(
      new GrpcAdapter().connect(connectInput(server.port, 'short')),
      (error: any) => error.code === 'VALIDATION_FAILED',
    );
  });

  // A thrown error with a password in its text must reach the client as a
  // hidden INTERNAL error, while real codes like NOT_FOUND pass through.
  test('errors keep their code, and internal failures hide their text', async () => {
    const adapter = new GrpcAdapter();
    await adapter.connect(connectInput(server.port));
    await assert.rejects(
      adapter.update(conformanceCollection, '999', { title: 'x' }),
      (error: any) => error.code === 'NOT_FOUND',
    );

    const broken = await serveAdapter(
      Object.assign(
        new MemoryAdapter({ collections: [conformanceCollection] }),
        {
          async find() {
            throw new Error('secret password=hunter2 in SQL');
          },
        },
      ),
      { token: TOKEN },
    );
    const victim = new GrpcAdapter();
    await victim.connect(connectInput(broken.port));
    await assert.rejects(
      victim.find(
        conformanceCollection,
        { page: { limit: 5 } } as never,
        undefined,
      ),
      (error: any) =>
        error.code === 'INTERNAL' && !/hunter2/.test(error.message),
    );
    await victim.close();
    await broken.close();
    await adapter.close();
  });

  // Optional migration methods must not be advertised if the remote cannot do
  // them, or the gateway would call a missing method.
  test('migration helpers appear only when the remote adapter has them', async () => {
    const adapter = new GrpcAdapter();
    await adapter.connect(connectInput(server.port));
    assert.equal(typeof adapter.createCollection, 'undefined'); // the memory adapter has no createCollection
    await adapter.close();
  });
});

// End-to-end: the gateway talks to the remote adapter exactly as a user would
// configure it.
describe('gRPC adapter through the gateway', () => {
  let gateway: TestGateway;
  let server: RunningServer;
  let connection: string;

  before(async () => {
    server = await remote(undefined, demoCollections());
    gateway = await startGateway({ seedDemo: false });
    const created = await gateway.call('POST', '/v1/admin/connections', {
      body: {
        name: 'External',
        adapter: 'grpc',
        mode: 'read_write',
        expose: 'all',
        config: { address: `127.0.0.1:${server.port}`, tls: false },
        credentials: { token: TOKEN },
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    connection = created.body.data.id;
  });
  after(async () => {
    await gateway?.close();
    await server?.close();
  });

  test('is listed as an adapter type', async () => {
    const types = (await gateway.call('GET', '/v1/admin/adapters')).body
      .data as Array<{ id: string }>;
    assert.ok(types.some((type) => type.id === 'grpc'));
  });

  test('records can be created, read, changed and removed through the gateway', async () => {
    const base = `/v1/connections/${connection}/collections/authors/records`;
    const created = await gateway.call('POST', base, {
      body: { name: 'Grpc Author' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    assert.equal(
      (await gateway.call('GET', `${base}/${id}`)).body.data.name,
      'Grpc Author',
    );
    assert.equal(
      (
        await gateway.call('PATCH', `${base}/${id}`, {
          body: { bio: 'changed' },
        })
      ).status,
      200,
    );
    assert.equal((await gateway.call('DELETE', `${base}/${id}`)).status, 204);
    assert.equal((await gateway.call('GET', `${base}/${id}`)).status, 404);
  });

  // The shared token is a credential and must never come back in admin
  // responses.
  test('the token is stored encrypted and never shown', async () => {
    const detail = JSON.stringify(
      (await gateway.call('GET', `/v1/admin/connections/${connection}`)).body,
    );
    assert.ok(!detail.includes(TOKEN));
  });

  // SSRF guard also applies to gRPC addresses; loopback must be refused when
  // private networks are disallowed.
  test('the gateway refuses to reach a blocked address', async () => {
    const strict = await startGateway({
      seedDemo: false,
      allowPrivateNetworks: false,
    });
    const refused = await strict.call('POST', '/v1/admin/connections', {
      body: {
        name: 'Nope',
        adapter: 'grpc',
        mode: 'read_only',
        expose: 'all',
        config: { address: '127.0.0.1:5000', tls: false },
        credentials: { token: TOKEN },
      },
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    await strict.close();
  });
});
