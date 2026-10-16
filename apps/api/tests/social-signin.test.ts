/**
 * Sign in with Firebase Authentication and with GitHub, against fake servers
 * that run inside the test. They prove our side: token checks, role lists and
 * the way sessions are created. They do not prove behaviour against the real
 * Firebase or GitHub; try yours before relying on it.
 */
import assert from 'node:assert/strict';
import {
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { configFromEnv } from '../src/config.js';
import { FirebaseVerifier, type FirebaseAuthConfig } from '../src/security/firebase.js';
import { startGateway, type TestGateway } from './helpers.js';

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

describe('sign in through Firebase Authentication', () => {
  const firebase = new FakeFirebase();
  let gateway: TestGateway;
  const firebaseConfig = (): FirebaseAuthConfig => ({
    projectId: 'demo-project',
    web: { apiKey: 'public-key', authDomain: 'demo-project.firebaseapp.com' },
    roles: { admin: ['boss@example.com'], editor: ['uid:uid-editor'], viewer: [] },
    allowedDomains: [],
    providers: ['google.com', 'github.com'],
    sessionHours: 8,
    jwksUrl: `${firebase.url}/keys`,
  });

  before(async () => {
    await firebase.start();
    gateway = await startGateway({ firebaseAuth: firebaseConfig() });
  });

  after(async () => {
    await gateway?.close();
    await firebase.stop();
  });

  const signIn = (idToken: string) =>
    gateway.call('POST', '/v1/auth/firebase', { token: null, body: { idToken } });

  it('tells the admin app how to open the Firebase popup', async () => {
    const config = await gateway.call('GET', '/v1/auth/config', { token: null });
    assert.equal(config.body.firebase.enabled, true);
    assert.equal(config.body.firebase.projectId, 'demo-project');
    assert.equal(config.body.firebase.apiKey, 'public-key');
    // Nothing secret is exposed.
    assert.ok(!JSON.stringify(config.body).includes('boss@example.com'));
  });

  it('gives an admin session to a verified listed address', async () => {
    const result = await signIn(
      firebase.token({ sub: 'uid-9', email: 'Boss@Example.com', email_verified: true }),
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.role, 'admin');
    const me = await gateway.call('GET', '/v1/me', { token: result.body.data.token });
    assert.equal(me.body.data.role, 'admin');
  });

  it('accepts a listed uid even without an e-mail (GitHub through Firebase)', async () => {
    const result = await signIn(
      firebase.token({ sub: 'uid-editor', firebase: { sign_in_provider: 'github.com' } }),
    );
    assert.equal(result.body.data.role, 'editor');
    // An editor must not reach administrator pages.
    assert.equal(
      (await gateway.call('GET', '/v1/admin/tokens', { token: result.body.data.token })).status,
      403,
    );
  });

  it('refuses people who are not listed, or whose address is unverified', async () => {
    for (const claims of [
      { sub: 'u2', email: 'stranger@example.com', email_verified: true },
      { sub: 'u3', email: 'boss@example.com', email_verified: false },
      { sub: 'u4' },
    ]) {
      assert.equal((await signIn(firebase.token(claims))).status, 401, JSON.stringify(claims));
    }
  });

  // Each case is a distinct attack on token checking. They go straight to the
  // verifier because the sign-in route is rate limited (10 attempts in a burst).
  it('rejects forged, stale or wrongly addressed tokens', async () => {
    const verifier = new FirebaseVerifier(firebaseConfig());
    const now = Math.floor(Date.now() / 1000);
    const good = { sub: 'uid-editor' };
    const cases: Array<[string, string]> = [
      ['unknown signing key', firebase.token(good, { key: firebase.other.privateKey })],
      ['unknown key id', firebase.token(good, { kid: 'nope' })],
      ['algorithm none', firebase.token(good, { alg: 'none' })],
      ['other project', firebase.token({ ...good, aud: 'other', iss: 'https://securetoken.google.com/other' })],
      ['wrong issuer', firebase.token({ ...good, iss: 'https://evil.example' })],
      ['expired', firebase.token({ ...good, exp: now - 3600 })],
      ['old sign-in', firebase.token({ ...good, auth_time: now - 3000 })],
      ['anonymous account', firebase.token({ ...good, firebase: { sign_in_provider: 'anonymous' } })],
      ['password account', firebase.token({ ...good, firebase: { sign_in_provider: 'password' } })],
      ['not a token', 'abc.def'],
    ];
    for (const [name, idToken] of cases) {
      await assert.rejects(() => verifier.verify(idToken), name);
    }
    assert.equal((await verifier.verify(firebase.token(good))).uid, 'uid-editor');
    assert.equal(
      (await gateway.call('POST', '/v1/auth/firebase', { token: null, body: {} })).status,
      400,
    );
  });
});

describe('sign in with GitHub', () => {
  let github!: Server;
  let url = '';
  /** What the fake GitHub says about whoever signs in next. */
  let who: { id: number; login: string } = { id: 1, login: 'octocat' };
  const codes = new Map<string, { state: string }>();
  const revoked: string[] = [];
  let gateway: TestGateway;
  let strict: TestGateway;

  before(async () => {
    github = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const json = (body: unknown, status = 200): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (u.pathname === '/login/oauth/access_token') {
          const form = new URLSearchParams(raw);
          if (!codes.has(form.get('code') ?? '') || form.get('client_secret') !== 'gh-secret' || !form.get('code_verifier')) {
            return json({ error: 'bad_verification_code' });
          }
          codes.delete(form.get('code') as string);
          return json({ access_token: 'gho_abc', token_type: 'bearer' });
        }
        if (u.pathname === '/user') {
          return req.headers['authorization'] === 'Bearer gho_abc' ? json(who) : json({}, 401);
        }
        if (u.pathname === '/applications/gh-client/token' && req.method === 'DELETE') {
          revoked.push(JSON.parse(raw).access_token);
          return json({}, 204);
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(github.address() as { port: number }).port}`;
    const settings = {
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
      redirectUri: 'http://127.0.0.1:0/v1/auth/github/callback',
      roles: { admin: ['OctoCat'], editor: ['id:42'], viewer: [] },
      sessionHours: 8,
      adminUrl: 'http://admin.test/',
      webUrl: url,
      apiUrl: url,
    };
    gateway = await startGateway({ github: settings });
    // A second gateway, so the failure cases do not share the first one's
    // rate limit.
    strict = await startGateway({ github: settings });
  });

  after(async () => {
    await gateway?.close();
    await strict?.close();
    await new Promise<void>((resolve) => github.close(() => resolve()));
  });

  /** Play the browser through login -> GitHub -> callback. */
  async function flow(
    tweak: { state?: string; dropCookie?: boolean; error?: string; badCode?: boolean } = {},
    gw: TestGateway = gateway,
  ) {
    const login = await fetch(`${gw.url}/v1/auth/github/login`, { redirect: 'manual' });
    assert.equal(login.status, 302);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
    const authorize = new URL(login.headers.get('location') as string);
    assert.equal(authorize.origin, url);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('scope'), null, 'no scope is requested');
    const code = tweak.badCode ? 'unknown' : `code-${randomBytes(4).toString('hex')}`;
    if (!tweak.badCode) {
      codes.set(code, { state: authorize.searchParams.get('state') as string });
    }
    const callback = new URL(authorize.searchParams.get('redirect_uri') as string);
    callback.searchParams.set('state', tweak.state ?? (authorize.searchParams.get('state') as string));
    if (tweak.error) {
      callback.searchParams.set('error', tweak.error);
    } else {
      callback.searchParams.set('code', code);
    }
    const done = await fetch(gw.url + callback.pathname + callback.search, {
      redirect: 'manual',
      headers: tweak.dropCookie ? {} : { Cookie: cookie },
    });
    assert.equal(done.status, 302);
    return new URLSearchParams(new URL(done.headers.get('location') as string).hash.slice(1));
  }

  it('is announced in the sign-in config', async () => {
    const config = await gateway.call('GET', '/v1/auth/config', { token: null });
    assert.deepEqual(config.body.github, { enabled: true, loginPath: '/v1/auth/github/login' });
  });

  it('signs in a listed user name (any case) as admin and revokes GitHub\'s token', async () => {
    who = { id: 7, login: 'octocat' };
    const fragment = await flow();
    const token = fragment.get('sso_token') as string;
    assert.ok(token);
    assert.equal((await gateway.call('GET', '/v1/me', { token })).body.data.role, 'admin');
    assert.deepEqual(revoked.slice(-1), ['gho_abc']);
  });

  it('signs in by numeric id, which survives a rename', async () => {
    who = { id: 42, login: 'renamed-person' };
    const token = (await flow()).get('sso_token') as string;
    assert.equal((await gateway.call('GET', '/v1/me', { token })).body.data.role, 'editor');
  });

  it('refuses anyone who is not listed', async () => {
    who = { id: 99, login: 'stranger' };
    const fragment = await flow();
    assert.equal(fragment.get('sso_error'), 'denied');
    assert.equal(fragment.get('sso_token'), null);
  });

  it('rejects a forged state, a lost cookie, a bad code and a provider error', async () => {
    who = { id: 7, login: 'octocat' };
    assert.equal((await flow({ state: 'forged' }, strict)).get('sso_error'), 'failed');
    assert.equal((await flow({ dropCookie: true }, strict)).get('sso_error'), 'expired');
    assert.equal((await flow({ badCode: true }, strict)).get('sso_error'), 'failed');
    assert.equal((await flow({ error: 'access_denied' }, strict)).get('sso_error'), 'denied');
  });
});

describe('sign-in settings from the environment', () => {
  const base = { SETHUCMS_PUBLIC_URL: 'https://cms.example.com' };

  it('builds Google sign-in from a few variables', () => {
    const config = configFromEnv({
      ...base,
      SETHUCMS_GOOGLE_CLIENT_ID: 'id',
      SETHUCMS_GOOGLE_CLIENT_SECRET: 'secret',
      SETHUCMS_GOOGLE_ADMINS: 'Me@Gmail.com, you@gmail.com',
    });
    assert.equal(config.oidc?.issuer, 'https://accounts.google.com');
    assert.equal(config.oidc?.roleClaim, 'email');
    assert.deepEqual(config.oidc?.roles.admin, ['me@gmail.com', 'you@gmail.com']);
    assert.equal(config.oidc?.redirectUri, 'https://cms.example.com/v1/auth/oidc/callback');
  });

  it('will not mix Google with another OpenID Connect provider', () => {
    assert.throws(() =>
      configFromEnv({
        ...base,
        SETHUCMS_GOOGLE_CLIENT_ID: 'id',
        SETHUCMS_GOOGLE_CLIENT_SECRET: 's',
        SETHUCMS_GOOGLE_ADMINS: 'a@b.com',
        SETHUCMS_OIDC_ISSUER: 'https://idp.example',
      }),
    );
  });

  it('refuses to start GitHub or Firebase sign-in that nobody could use', () => {
    assert.throws(() =>
      configFromEnv({ ...base, SETHUCMS_GITHUB_CLIENT_ID: 'id', SETHUCMS_GITHUB_CLIENT_SECRET: 's' }),
    );
    assert.throws(() =>
      configFromEnv({ SETHUCMS_FIREBASE_AUTH_PROJECT: 'demo-project', SETHUCMS_FIREBASE_AUTH_API_KEY: 'k' }),
    );
    assert.throws(() =>
      configFromEnv({
        ...base,
        SETHUCMS_GITHUB_CLIENT_ID: 'id',
        SETHUCMS_GITHUB_CLIENT_SECRET: 's',
        SETHUCMS_GITHUB_ADMINS: 'bad name!',
      }),
    );
  });

  it('reads GitHub and Firebase settings', () => {
    const config = configFromEnv({
      ...base,
      SETHUCMS_GITHUB_CLIENT_ID: 'id',
      SETHUCMS_GITHUB_CLIENT_SECRET: 's',
      SETHUCMS_GITHUB_ADMINS: 'octocat,id:583231',
      SETHUCMS_FIREBASE_AUTH_PROJECT: 'demo-project',
      SETHUCMS_FIREBASE_AUTH_API_KEY: 'k',
      SETHUCMS_FIREBASE_ADMINS: 'A@b.com',
    });
    assert.equal(config.github?.redirectUri, 'https://cms.example.com/v1/auth/github/callback');
    assert.deepEqual(config.github?.roles.admin, ['octocat', 'id:583231']);
    assert.equal(config.firebaseAuth?.web.authDomain, 'demo-project.firebaseapp.com');
    assert.deepEqual(config.firebaseAuth?.roles.admin, ['a@b.com']);
  });
});
