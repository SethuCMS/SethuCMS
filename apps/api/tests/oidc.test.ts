/**
 * Single sign-on against a fake identity provider that runs inside the test.
 * It proves our side of the protocol. It does not prove compatibility with a
 * particular provider (Keycloak, Google, Entra ID...): try yours before relying on it.
 */
import assert from 'node:assert/strict';
import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { OidcConfig } from '../src/security/oidc.js';
import { ADMIN_TOKEN, startGateway, type TestGateway } from './helpers.js';

const b64 = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url');

/** A tiny OpenID provider: discovery, JWKS, authorize (we skip the page), token. */
class FakeProvider {
  server!: Server;
  url = '';
  readonly rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  /** What the next token exchange returns. */
  next: {
    claims: Record<string, unknown>;
    key?: KeyObject;
    alg?: string;
    kid?: string;
    userinfo?: Record<string, unknown>;
  } = { claims: {} };
  /** code -> what the browser sent to /authorize */
  readonly codes = new Map<
    string,
    { nonce: string; challenge: string; redirect: string; state: string }
  >();
  tokenRequests: URLSearchParams[] = [];
  lastAuth: string | undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', this.url);
      const json = (body: unknown, status = 200): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({
          issuer: this.url,
          authorization_endpoint: `${this.url}/authorize`,
          token_endpoint: `${this.url}/token`,
          jwks_uri: `${this.url}/jwks`,
          userinfo_endpoint: `${this.url}/userinfo`,
        });
      }
      if (url.pathname === '/jwks') {
        return json({
          keys: [
            {
              ...this.rsa.publicKey.export({ format: 'jwk' }),
              kid: 'rsa-1',
              use: 'sig',
              alg: 'RS256',
            },
            {
              ...this.ec.publicKey.export({ format: 'jwk' }),
              kid: 'ec-1',
              use: 'sig',
              alg: 'ES256',
            },
          ],
        });
      }
      if (url.pathname === '/userinfo') {
        return json({
          sub: this.next.claims['sub'],
          ...(this.next.userinfo ?? {}),
        });
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const form = new URLSearchParams(body);
          this.tokenRequests.push(form);
          this.lastAuth = req.headers['authorization'] as string | undefined;
          const saved = this.codes.get(form.get('code') ?? '');
          if (!saved) {
            return json({ error: 'invalid_grant' }, 400);
          }
          // One-time use stops a captured code being replayed.
          this.codes.delete(form.get('code') as string); // a code works once
          // PKCE: the verifier must hash to the challenge sent to /authorize.
          const expected = createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url');
          if (expected !== saved.challenge) {
            return json(
              { error: 'invalid_grant', error_description: 'PKCE failed' },
              400,
            );
          }
          // Lets each test choose the signing algorithm, key and key id, to
          // forge tokens on purpose.
          const alg = this.next.alg ?? 'RS256';
          const key =
            this.next.key ??
            (alg === 'ES256' ? this.ec.privateKey : this.rsa.privateKey);
          const kid = this.next.kid ?? (alg === 'ES256' ? 'ec-1' : 'rsa-1');
          const now = Math.floor(Date.now() / 1000);
          const claims = {
            iss: this.url,
            aud: 'sethucms-client',
            iat: now,
            exp: now + 300,
            nonce: saved.nonce,
            ...this.next.claims,
          };
          return json({
            id_token: this.jwt(claims, alg, key, kid),
            access_token: 'access-abc',
            token_type: 'Bearer',
          });
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  jwt(
    claims: Record<string, unknown>,
    alg: string,
    key: KeyObject,
    kid: string,
  ): string {
    // Hand-signs tokens so the test can produce invalid ones (alg none, wrong
    // key) that a library would refuse to mint.
    const head = b64(JSON.stringify({ alg, kid, typ: 'JWT' }));
    const body = b64(JSON.stringify(claims));
    const data = Buffer.from(`${head}.${body}`);
    const signature =
      alg === 'none'
        ? Buffer.alloc(0)
        : alg === 'ES256'
          ? cryptoSign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })
          : createSign('RSA-SHA256').update(data).sign(key);
    return `${head}.${body}.${b64(signature)}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// The tweaks model attacks - a forged state, a lost cookie, or an error from
// the provider.
/** Play the browser: start a sign-in, follow it to the provider, come back to the gateway. */
async function signIn(
  gateway: TestGateway,
  provider: FakeProvider,
  tweak: { state?: string; dropCookie?: boolean; error?: string } = {},
): Promise<{ location: string; fragment: URLSearchParams }> {
  const login = await fetch(`${gateway.url}/v1/auth/oidc/login`, {
    redirect: 'manual',
  });
  assert.equal(login.status, 302);
  // The login cookie carries the state and PKCE secrets, so the callback must
  // be tied to the browser that started the flow.
  const cookie = (login.headers.get('set-cookie') ?? '').split(
    ';',
  )[0] as string;
  const authorize = new URL(login.headers.get('location') as string);
  assert.equal(authorize.origin, provider.url);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('response_type'), 'code');

  const code = `code-${randomBytes(6).toString('hex')}`;
  provider.codes.set(code, {
    nonce: authorize.searchParams.get('nonce') as string,
    challenge: authorize.searchParams.get('code_challenge') as string,
    redirect: authorize.searchParams.get('redirect_uri') as string,
    state: authorize.searchParams.get('state') as string,
  });
  const callback = new URL(
    authorize.searchParams.get('redirect_uri') as string,
  );
  callback.searchParams.set(
    'state',
    tweak.state ?? (authorize.searchParams.get('state') as string),
  );
  if (tweak.error) {
    callback.searchParams.set('error', tweak.error);
  } else {
    callback.searchParams.set('code', code);
  }

  const target = callback.pathname + callback.search;
  const finished = await fetch(gateway.url + target, {
    redirect: 'manual',
    headers: tweak.dropCookie ? {} : { Cookie: cookie },
  });
  assert.equal(finished.status, 302);
  const location = finished.headers.get('location') as string;
  return {
    location,
    fragment: new URLSearchParams(new URL(location).hash.slice(1)),
  };
}

describe('single sign-on (OpenID Connect)', () => {
  const provider = new FakeProvider();
  let gateway: TestGateway;

  // Sign-in is the front door, so every failure path is tested as well as the
  // happy one.
  before(async () => {
    await provider.start();
    const oidc: OidcConfig = {
      issuer: provider.url,
      clientId: 'sethucms-client',
      clientSecret: 's3cret',
      redirectUri: 'http://127.0.0.1:0/v1/auth/oidc/callback',
      scopes: 'openid email profile',
      roleClaim: 'groups',
      roles: {
        admin: ['cms-admins'],
        editor: ['cms-editors'],
        viewer: ['cms-viewers'],
      },
      allowedDomains: [],
      sessionHours: 8,
      adminUrl: 'http://admin.test/',
    };
    // The redirect address must be the gateway's own, so start once to learn the port, then restart is not needed:
    // we only need the path, and the fake browser follows whatever address the gateway sent.
    gateway = await startGateway({ oidc });
  });

  after(async () => {
    await gateway?.close();
    await provider.stop();
  });

  const user = (extra: Record<string, unknown> = {}) => ({
    sub: `user-${randomBytes(3).toString('hex')}`,
    email: 'mira@example.com',
    email_verified: true,
    groups: ['cms-editors'],
    ...extra,
  });

  // The admin app decides whether to show the sign-in button from this
  // response.
  it('tells the admin app that single sign-on is on', async () => {
    const config = await gateway.call('GET', '/v1/auth/config', {
      token: null,
    });
    assert.deepEqual(config.body, {
      oidc: { enabled: true, loginPath: '/v1/auth/oidc/login' },
    });
  });

  // Group-to-role mapping is the authorisation decision; the session token is
  // delivered in the URL fragment so it never reaches server logs.
  it('signs a person in and gives them the role their group maps to', async () => {
    provider.next = { claims: user({ groups: ['cms-editors'] }) };
    const { fragment, location } = await signIn(gateway, provider);
    assert.ok(location.startsWith('http://admin.test/#'), location);
    const token = fragment.get('sso_token') as string;
    assert.ok(token, 'a session token arrives in the URL fragment');
    assert.ok(Date.parse(fragment.get('sso_expires') as string) > Date.now());

    const me = await gateway.call('GET', '/v1/me', { token });
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.data.role, 'editor');
    // An editor must not reach administrator pages.
    assert.equal(
      (await gateway.call('GET', '/v1/admin/tokens', { token })).status,
      403,
    );
    // The client authenticated itself with its secret.
    assert.ok(provider.lastAuth?.startsWith('Basic '));
  });

  // Several groups must resolve to the most privileged role deterministically,
  // not by claim order.
  it('gives the highest role when several groups match', async () => {
    provider.next = {
      claims: user({ groups: ['cms-viewers', 'cms-admins', 'cms-editors'] }),
    };
    const { fragment } = await signIn(gateway, provider);
    const me = await gateway.call('GET', '/v1/me', {
      token: fragment.get('sso_token') as string,
    });
    assert.equal(me.body.data.role, 'admin');
  });

  // Unmapped users get no session at all; a default would grant access to
  // everyone in the directory.
  it('refuses a person whose groups match no role', async () => {
    provider.next = { claims: user({ groups: ['marketing'] }) };
    const { fragment } = await signIn(gateway, provider);
    assert.equal(fragment.get('sso_error'), 'denied');
    assert.equal(fragment.get('sso_token'), null);
  });

  // Some providers keep group membership out of the ID token, so the userinfo
  // fallback must work.
  it('reads groups from userinfo when the ID token has none', async () => {
    const claims = user();
    delete (claims as Record<string, unknown>)['groups'];
    provider.next = { claims, userinfo: { groups: ['cms-viewers'] } };
    const { fragment } = await signIn(gateway, provider);
    const me = await gateway.call('GET', '/v1/me', {
      token: fragment.get('sso_token') as string,
    });
    assert.equal(me.body.data.role, 'viewer');
  });

  // ES256 uses a different signature encoding (raw r||s), which is easy to
  // verify incorrectly.
  it('accepts an ES256 signature', async () => {
    provider.next = { claims: user(), alg: 'ES256' };
    const { fragment } = await signIn(gateway, provider);
    assert.ok(fragment.get('sso_token'));
  });

  // Each case is a distinct attack on token validation; any one accepted means
  // identity can be forged.
  it('rejects forged or invalid ID tokens', async () => {
    const cases: Array<[string, typeof provider.next]> = [
      [
        'signed with a key the provider does not publish',
        { claims: user(), key: provider.other.privateKey },
      ],
      ['wrong audience', { claims: user({ aud: 'someone-else' }) }],
      ['wrong issuer', { claims: user({ iss: 'https://evil.example' }) }],
      [
        'expired',
        { claims: user({ exp: Math.floor(Date.now() / 1000) - 3600 }) },
      ],
      ['wrong nonce', { claims: user({ nonce: 'replayed' }) }],
      ['algorithm none', { claims: user(), alg: 'none' }],
      ['unknown key id', { claims: user(), kid: 'missing' }],
    ];
    for (const [name, next] of cases) {
      provider.next = next;
      const { fragment } = await signIn(gateway, provider);
      assert.equal(fragment.get('sso_error'), 'failed', name);
      assert.equal(fragment.get('sso_token'), null, name);
    }
  });

  // State protects against login CSRF, and a missing cookie means the flow did
  // not start here.
  it('rejects a callback with the wrong state, no cookie, or a provider error', async () => {
    provider.next = { claims: user() };
    assert.equal(
      (await signIn(gateway, provider, { state: 'forged-state' })).fragment.get(
        'sso_error',
      ),
      'failed',
    );
    assert.equal(
      (await signIn(gateway, provider, { dropCookie: true })).fragment.get(
        'sso_error',
      ),
      'expired',
    );
    assert.equal(
      (
        await signIn(gateway, provider, { error: 'access_denied' })
      ).fragment.get('sso_error'),
      'denied',
    );
  });

  // Authorization codes are single use; a replay must fail even with a valid
  // cookie and state.
  it('does not accept a code twice', async () => {
    provider.next = { claims: user() };
    const login = await fetch(`${gateway.url}/v1/auth/oidc/login`, {
      redirect: 'manual',
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(
      ';',
    )[0] as string;
    const authorize = new URL(login.headers.get('location') as string);
    const code = 'one-time-code';
    provider.codes.set(code, {
      nonce: authorize.searchParams.get('nonce') as string,
      challenge: authorize.searchParams.get('code_challenge') as string,
      redirect: '',
      state: '',
    });
    const path = `/v1/auth/oidc/callback?state=${encodeURIComponent(authorize.searchParams.get('state') as string)}&code=${code}`;
    const first = await fetch(gateway.url + path, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    assert.ok((first.headers.get('location') ?? '').includes('sso_token='));
    const second = await fetch(gateway.url + path, {
      redirect: 'manual',
      headers: { Cookie: cookie },
    });
    assert.ok(
      (second.headers.get('location') ?? '').includes('sso_error=failed'),
    );
  });

  // Logout must really invalidate the session; static API tokens are not
  // sessions and must survive it.
  it('logs out: the session token stops working, and an API token cannot be logged out this way', async () => {
    provider.next = { claims: user() };
    const { fragment } = await signIn(gateway, provider);
    const token = fragment.get('sso_token') as string;
    assert.equal(
      (await gateway.call('POST', '/v1/auth/logout', { token })).status,
      204,
    );
    assert.equal((await gateway.call('GET', '/v1/me', { token })).status, 401);

    assert.equal(
      (await gateway.call('POST', '/v1/auth/logout', { token: ADMIN_TOKEN }))
        .status,
      204,
    );
    assert.equal(
      (await gateway.call('GET', '/v1/me', { token: ADMIN_TOKEN })).status,
      200,
    );
  });

  // Audit entries show who signed in, but must not contain tokens.
  it('records sign-ins and refusals in the audit log, without tokens', async () => {
    const entries = (await gateway.call('GET', '/v1/admin/audit?limit=200'))
      .body.data as Array<{ operation: string; detail?: unknown }>;
    assert.ok(entries.some((e) => e.operation === 'auth.sso.login'));
    assert.ok(entries.some((e) => e.operation === 'auth.sso.denied'));
    assert.ok(
      !JSON.stringify(entries).includes('adb_'),
      'no session token in the audit log',
    );
  });

  // Caps the number of concurrent sessions, so a stolen identity cannot pile up
  // unlimited tokens.
  it('keeps at most five live sessions per person', async () => {
    const sub = `repeat-${randomBytes(3).toString('hex')}`;
    const tokens: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      provider.next = { claims: user({ sub }) };
      tokens.push(
        (await signIn(gateway, provider)).fragment.get('sso_token') as string,
      );
    }
    const live = (
      await Promise.all(
        tokens.map((token) => gateway.call('GET', '/v1/me', { token })),
      )
    ).filter((r) => r.status === 200).length;
    assert.equal(live, 5);
  });
});

// A domain allowlist must demand a verified email, or anyone could claim an
// address they do not own.
describe('single sign-on with an email-domain rule', () => {
  const provider = new FakeProvider();
  let gateway: TestGateway;

  before(async () => {
    await provider.start();
    gateway = await startGateway({
      oidc: {
        issuer: provider.url,
        clientId: 'sethucms-client',
        redirectUri: 'http://127.0.0.1:0/v1/auth/oidc/callback',
        scopes: 'openid email',
        roleClaim: 'groups',
        roles: { admin: [], editor: [], viewer: [] },
        defaultRole: 'viewer',
        allowedDomains: ['example.com'],
        sessionHours: 1,
        adminUrl: 'http://admin.test/',
      },
    });
  });
  after(async () => {
    await gateway?.close();
    await provider.stop();
  });

  it('lets verified addresses from the allowed domain in as the default role, and nobody else', async () => {
    provider.next = {
      claims: { sub: 'a1', email: 'a@example.com', email_verified: true },
    };
    const ok = await signIn(gateway, provider);
    assert.equal(
      (
        await gateway.call('GET', '/v1/me', {
          token: ok.fragment.get('sso_token') as string,
        })
      ).body.data.role,
      'viewer',
    );

    provider.next = {
      claims: { sub: 'a2', email: 'a@other.com', email_verified: true },
    };
    assert.equal(
      (await signIn(gateway, provider)).fragment.get('sso_error'),
      'denied',
    );

    provider.next = {
      claims: { sub: 'a3', email: 'a@example.com', email_verified: false },
    };
    assert.equal(
      (await signIn(gateway, provider)).fragment.get('sso_error'),
      'denied',
    );
  });
});
