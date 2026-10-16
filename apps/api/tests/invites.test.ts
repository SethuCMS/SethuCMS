/**
 * Inviting people by e-mail address: an admin adds an address and a role in the
 * panel, and that person can then sign in with Google or GitHub. Uses the same
 * fake Firebase as the social sign-in tests.
 */
import assert from 'node:assert/strict';
import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { type FirebaseAuthConfig } from '../src/security/firebase.js';
import { startGateway, tokenFor, type TestGateway } from './helpers.js';

const b64 = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url');

/** Serves Firebase's signing keys and mints tokens (including bad ones). */
class FakeFirebase {
  server!: Server;
  url = '';
  readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly other = generateKeyPairSync('rsa', { modulusLength: 2048 });

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      if (req.url === '/keys') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            keys: [{ ...this.key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  token(
    claims: Record<string, unknown>,
    opts: { key?: KeyObject; alg?: string; kid?: string } = {},
  ): string {
    const now = Math.floor(Date.now() / 1000);
    const body = {
      iss: 'https://securetoken.google.com/demo-project',
      aud: 'demo-project',
      iat: now,
      exp: now + 3600,
      auth_time: now,
      sub: 'uid-1',
      firebase: { sign_in_provider: 'google.com' },
      ...claims,
    };
    const head = b64(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' }));
    const payload = b64(JSON.stringify(body));
    const signature =
      opts.alg === 'none'
        ? Buffer.alloc(0)
        : createSign('RSA-SHA256').update(`${head}.${payload}`).sign(opts.key ?? this.key.privateKey);
    return `${head}.${payload}.${b64(signature)}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

describe('invite people by e-mail', () => {
  const firebase = new FakeFirebase();
  let gateway: TestGateway;
  const config = (allowedDomains: string[] = []): FirebaseAuthConfig => ({
    projectId: 'demo-project',
    web: { apiKey: 'public-key', authDomain: 'demo-project.firebaseapp.com' },
    roles: { admin: ['boss@example.com'], editor: [], viewer: [] },
    allowedDomains,
    providers: ['google.com', 'github.com'],
    sessionHours: 8,
    jwksUrl: `${firebase.url}/keys`,
  });
  before(async () => {
    await firebase.start();
    gateway = await startGateway({ firebaseAuth: config() });
  });
  after(async () => {
    await gateway?.close();
    await firebase.stop();
  });

  const signIn = (email: string, verified = true, sub = 'uid-new') =>
    gateway.call('POST', '/v1/auth/firebase', {
      token: null,
      body: { idToken: firebase.token({ sub, email, email_verified: verified }) },
    });
  const invite = (email: unknown, role: unknown, token?: string) =>
    gateway.call('POST', '/v1/admin/invites', {
      body: { email, role },
      ...(token ? { token } : {}),
    });

  it('lets an invited, verified address sign in with the invited role', async () => {
    assert.equal((await signIn('Asha@Example.com')).status, 401);
    const made = await invite('Asha@Example.com', 'admin');
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.data.email, 'asha@example.com');
    const result = await signIn('asha@example.com');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.role, 'admin');
    // An invited admin can use admin pages, including inviting someone else.
    const again = await invite('lee@example.com', 'editor', result.body.data.token);
    assert.equal(again.status, 201);
    const list = await gateway.call('GET', '/v1/admin/invites');
    assert.equal(list.body.data.length, 2);
  });

  it('does not accept an unverified address, even when invited', async () => {
    await invite('fake@example.com', 'admin');
    assert.equal((await signIn('fake@example.com', false, 'uid-f')).status, 401);
  });

  it('refuses a repeated address, bad input, and non-admins', async () => {
    assert.equal((await invite('asha@example.com', 'editor')).status, 409);
    assert.equal((await invite('not-an-address', 'editor')).status, 400);
    assert.equal((await invite('x@example.com', 'owner')).status, 400);
    const editor = await tokenFor(gateway, 'editor');
    assert.equal((await invite('y@example.com', 'editor', editor)).status, 403);
    assert.equal(
      (await gateway.call('GET', '/v1/admin/invites', { token: editor })).status,
      403,
    );
  });

  it('removing an invitation ends that person\'s sessions and blocks new sign-in', async () => {
    const session = await signIn('lee@example.com', true, 'uid-lee');
    assert.equal(session.body.data.role, 'editor');
    const list = await gateway.call('GET', '/v1/admin/invites');
    const lee = list.body.data.find((item: { email: string }) => item.email === 'lee@example.com');
    assert.equal((await gateway.call('DELETE', `/v1/admin/invites/${lee.id}`)).status, 204);
    assert.equal(
      (await gateway.call('GET', '/v1/me', { token: session.body.data.token })).status,
      401,
    );
    assert.equal((await signIn('lee@example.com', true, 'uid-lee')).status, 401);
    assert.equal((await gateway.call('DELETE', `/v1/admin/invites/${lee.id}`)).status, 404);
  });

  it('keeps the environment lists working and writes to the audit log', async () => {
    assert.equal((await signIn('boss@example.com', true, 'uid-b')).body.data.role, 'admin');
    const audit = await gateway.call('GET', '/v1/admin/audit');
    const text = JSON.stringify(audit.body);
    assert.ok(text.includes('invite.create') && text.includes('invite.delete'));
  });
});

describe('invitations and the domain allow-list', () => {
  const firebase = new FakeFirebase();
  let gateway: TestGateway;
  before(async () => {
    await firebase.start();
    gateway = await startGateway({
      firebaseAuth: {
        projectId: 'demo-project',
        web: { apiKey: 'k', authDomain: 'demo-project.firebaseapp.com' },
        roles: { admin: [], editor: [], viewer: [] },
        allowedDomains: ['example.com'],
        providers: ['google.com'],
        sessionHours: 8,
        jwksUrl: `${firebase.url}/keys`,
      },
    });
  });
  after(async () => {
    await gateway?.close();
    await firebase.stop();
  });
  it('still refuses an invited address outside the allowed domains', async () => {
    await gateway.call('POST', '/v1/admin/invites', {
      body: { email: 'out@elsewhere.org', role: 'admin' },
    });
    const result = await gateway.call('POST', '/v1/auth/firebase', {
      token: null,
      body: { idToken: firebase.token({ sub: 'u', email: 'out@elsewhere.org', email_verified: true }) },
    });
    assert.equal(result.status, 401);
  });
});
