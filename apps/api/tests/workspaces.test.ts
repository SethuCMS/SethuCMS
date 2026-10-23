/**
 * Workspaces: every person who signs in gets a gateway of their own, and one
 * person can never reach another's data. These run against a fake Firebase.
 */
import assert from 'node:assert/strict';
import {
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { FirebaseAuthConfig } from '../src/security/firebase.js';
import { FakeStateFirestore } from './fake-state-firestore.js';
import { ADMIN_TOKEN, startGateway, type TestGateway } from './helpers.js';

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


describe('workspaces', () => {
  const firebase = new FakeFirebase();
  let gateway: TestGateway;
  const config = (): FirebaseAuthConfig => ({
    projectId: 'demo-project',
    web: { apiKey: 'public-key', authDomain: 'demo-project.firebaseapp.com' },
    roles: { admin: ['team@example.com'], editor: [], viewer: [] },
    allowedDomains: [],
    providers: ['google.com', 'github.com'],
    sessionHours: 8,
    jwksUrl: `${firebase.url}/keys`,
  });
  const person = (uid: string, email: string, verified = true) =>
    firebase.token({ sub: uid, email, email_verified: verified });

  before(async () => {
    await firebase.start();
    gateway = await startGateway(
      { firebaseAuth: config(), seedDemo: false },
      {
        env: {
          SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
          SETHUCMS_WORKSPACES: 'open',
          SETHUCMS_WORKSPACE_SECRET: 'w'.repeat(40),
          // Test state lives in memory, so a closed workspace would lose it.
          SETHUCMS_WORKSPACES_OPEN: '64',
        },
        rateLimit: { capacity: 10_000, refillPerSecond: 10_000 },
      },
    );
  });
  after(async () => {
    await gateway?.close();
    await firebase.stop();
  });

  // Sign-in is rate limited per address, so each person signs in once.
  const sessions = new Map<string, Promise<any>>();
  const signin = (idToken: string) =>
    gateway.call('POST', '/v1/workspaces/signin', { token: null, body: { idToken } });
  const session = (uid: string, email: string) => {
    if (!sessions.has(uid)) {
      sessions.set(uid, signin(person(uid, email)));
    }
    return sessions.get(uid)!;
  };
  const inWorkspace = (id: string, method: string, path: string, token: string | null, body?: unknown) =>
    gateway.call(method, `/w/${id}${path}`, { token, ...(body === undefined ? {} : { body }) });

  it('announces workspaces to the admin app', async () => {
    const response = await gateway.call('GET', '/v1/auth/config', { token: null });
    assert.equal(response.body.firebase.workspaces, true);
  });

  it('keeps the main workspace for people named in the gateway settings', async () => {
    const result = await session('uid-team', 'team@example.com');
    assert.equal(result.status, 200);
    assert.equal(result.body.data.workspace, null);
    assert.equal(result.body.data.role, 'admin');
    const list = await gateway.call('GET', '/v1/connections', { token: result.body.data.token });
    assert.equal(list.status, 200);
  });

  it('gives each other person a workspace of their own, as its admin', async () => {
    const alice = await session('uid-alice', 'alice@example.com');
    const bob = await session('uid-bob', 'bob@example.com');
    assert.equal(alice.status, 200);
    assert.equal(alice.body.data.role, 'admin');
    assert.match(alice.body.data.workspace, /^w[0-9a-f]{40}$/);
    assert.notEqual(alice.body.data.workspace, bob.body.data.workspace);
    // Same person, same workspace.
    const again = await session('uid-alice', 'alice@example.com');
    assert.equal(again.body.data.workspace, alice.body.data.workspace);
  });

  it('never shows one workspace to another person', async () => {
    const alice = (await session('uid-alice', 'alice@example.com')).body.data;
    const bob = (await session('uid-bob', 'bob@example.com')).body.data;
    const made = await inWorkspace(alice.workspace, 'POST', '/v1/admin/connections', alice.token, {
      name: 'Alice database',
      adapter: 'memory',
      mode: 'read_write',
      expose: 'all',
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const aliceList = await inWorkspace(alice.workspace, 'GET', '/v1/connections', alice.token);
    assert.equal(aliceList.body.data.length, 1);

    // Bob's own workspace is empty.
    const bobList = await inWorkspace(bob.workspace, 'GET', '/v1/connections', bob.token);
    assert.equal(bobList.status, 200);
    assert.equal(bobList.body.data.length, 0);
    // Bob's token means nothing in Alice's workspace, and the reverse.
    assert.equal((await inWorkspace(alice.workspace, 'GET', '/v1/connections', bob.token)).status, 401);
    assert.equal((await inWorkspace(bob.workspace, 'GET', '/v1/connections', alice.token)).status, 401);
    // The main workspace does not contain it either.
    const main = await gateway.call('GET', '/v1/connections', { token: ADMIN_TOKEN });
    assert.equal(
      main.body.data.some((item: { name: string }) => item.name === 'Alice database'),
      false,
    );
    // Neither the main admin token nor a workspace token crosses over.
    assert.equal((await inWorkspace(alice.workspace, 'GET', '/v1/connections', ADMIN_TOKEN)).status, 401);
    assert.equal((await gateway.call('GET', '/v1/connections', { token: alice.token })).status, 401);
  });

  it('keeps tokens, people and invitations separate too', async () => {
    const alice = (await session('uid-alice', 'alice@example.com')).body.data;
    const bob = (await session('uid-bob', 'bob@example.com')).body.data;
    const invite = await inWorkspace(alice.workspace, 'POST', '/v1/admin/invites', alice.token, {
      email: 'carol@example.com',
      role: 'editor',
    });
    assert.equal(invite.status, 201);
    const bobInvites = await inWorkspace(bob.workspace, 'GET', '/v1/admin/invites', bob.token);
    assert.equal(
      bobInvites.body.data.some((item: { email: string }) => item.email === 'carol@example.com'),
      false,
    );
    const bobTokens = await inWorkspace(bob.workspace, 'GET', '/v1/admin/tokens', bob.token);
    assert.equal(bobTokens.status, 200);
    assert.equal(
      JSON.stringify(bobTokens.body).includes(alice.token),
      false,
    );
  });

  it('lets an invited teammate in to that workspace only', async () => {
    const alice = (await session('uid-alice', 'alice@example.com')).body.data;
    const bob = (await session('uid-bob', 'bob@example.com')).body.data;
    await inWorkspace(alice.workspace, 'POST', '/v1/admin/invites', alice.token, {
      email: 'dave@example.com',
      role: 'viewer',
    }).catch(() => undefined);
    const dave = person('uid-dave', 'dave@example.com');
    const joined = await gateway.call('POST', `/w/${alice.workspace}/v1/auth/firebase`, {
      token: null,
      body: { idToken: dave },
    });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.data.role, 'viewer');
    // Not on the list in Bob's workspace.
    const refused = await gateway.call('POST', `/w/${bob.workspace}/v1/auth/firebase`, {
      token: null,
      body: { idToken: dave },
    });
    assert.equal(refused.status, 401);
    // Dave's own sign-in at the front door gives him his own workspace.
    const own = await signin(dave);
    assert.equal(own.body.data.role, 'admin');
    assert.notEqual(own.body.data.workspace, alice.workspace);
  });

  it('refuses invented workspace ids and unverified e-mail addresses', async () => {
    assert.equal(
      (await gateway.call('GET', `/w/w${'0'.repeat(40)}/v1/connections`, { token: ADMIN_TOKEN })).status,
      404,
    );
    assert.equal((await gateway.call('GET', '/w/nonsense/v1/connections', { token: ADMIN_TOKEN })).status, 404);
    const unverified = await signin(person('uid-eve', 'eve@example.com', false));
    assert.equal(unverified.status, 401);
    const bad = await signin('not-a-token');
    assert.equal(bad.status, 401);
  });

  it('a workspace cannot reach the gateway’s private network', async () => {
    const alice = (await session('uid-alice', 'alice@example.com')).body.data;
    const made = await inWorkspace(alice.workspace, 'POST', '/v1/admin/connections', alice.token, {
      name: 'Inside job',
      adapter: 'postgres',
      mode: 'read_only',
      expose: 'all',
      config: { host: '127.0.0.1', port: 5432, database: 'x', user: 'x', password: 'x', ssl: false },
    });
    assert.notEqual(made.status, 201, 'private addresses must be refused');
  });

  describe('projects', () => {
    const projects = (id: string, method: string, path: string, token: string, body?: unknown) =>
      inWorkspace(id, method, `/v1/projects${path}`, token, body);

    it('lists a first project, then creates and switches between projects', async () => {
      const pia = (await session('uid-pia', 'pia@example.com')).body.data;
      const first = await projects(pia.workspace, 'GET', '', pia.token);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.data.projects.length, 1);
      assert.equal(first.body.data.projects[0].owner, true);
      assert.equal(first.body.data.current, pia.workspace);

      const made = await projects(pia.workspace, 'POST', '', pia.token, { name: '  Blog  ' });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.equal(made.body.data.name, 'Blog');
      assert.equal(made.body.data.role, 'admin');
      const blog = made.body.data;
      assert.notEqual(blog.workspace, pia.workspace);
      // The new session works in the new project, which starts empty.
      const empty = await inWorkspace(blog.workspace, 'GET', '/v1/connections', blog.token);
      assert.equal(empty.status, 200);
      assert.equal(empty.body.data.length, 0);
      // Seen from the new project, the list is the same and says where we are.
      const fromBlog = await projects(blog.workspace, 'GET', '', blog.token);
      assert.equal(fromBlog.body.data.projects.length, 2);
      assert.equal(fromBlog.body.data.current, blog.workspace);

      const back = await projects(blog.workspace, 'POST', `/${pia.workspace}/switch`, blog.token);
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.equal(back.body.data.role, 'admin');
      const ok = await inWorkspace(pia.workspace, 'GET', '/v1/connections', back.body.data.token);
      assert.equal(ok.status, 200);
    });

    it('keeps projects of different people apart', async () => {
      const quinn = (await session('uid-quinn', 'quinn@example.com')).body.data;
      const rex = (await session('uid-rex', 'rex@example.com')).body.data;
      const mine = (
        await projects(quinn.workspace, 'POST', '', quinn.token, { name: 'Quinn only' })
      ).body.data;
      const listed = await projects(rex.workspace, 'GET', '', rex.token);
      assert.equal(JSON.stringify(listed.body).includes(mine.id), false);
      assert.equal(
        (await projects(rex.workspace, 'POST', `/${mine.id}/switch`, rex.token)).status,
        404,
      );
      assert.equal(
        (await projects(rex.workspace, 'PATCH', `/${mine.id}`, rex.token, { name: 'Mine now' })).status,
        404,
      );
      assert.equal(
        (await projects(rex.workspace, 'DELETE', `/${mine.id}`, rex.token, { confirm: 'Quinn only' }))
          .status,
        404,
      );
    });

    it('checks names, renames, and locks a deleted project', async () => {
      const sam = (await session('uid-sam', 'sam@example.com')).body.data;
      for (const name of ['', '   ', 'x'.repeat(61), 'bad\u0007name', 7]) {
        const refused = await projects(sam.workspace, 'POST', '', sam.token, { name });
        assert.equal(refused.status, 400, `name ${String(name)}`);
      }
      const made = (await projects(sam.workspace, 'POST', '', sam.token, { name: 'Shop' })).body.data;
      const renamed = await projects(sam.workspace, 'PATCH', `/${made.id}`, sam.token, {
        name: 'Shop two',
      });
      assert.equal(renamed.status, 200);
      const wrong = await projects(sam.workspace, 'DELETE', `/${made.id}`, sam.token, {
        confirm: 'Shop',
      });
      assert.equal(wrong.status, 400);
      const deleted = await projects(sam.workspace, 'DELETE', `/${made.id}`, sam.token, {
        confirm: 'Shop two',
      });
      assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
      // Nobody gets in any more, including the owner's old session.
      assert.equal((await inWorkspace(made.id, 'GET', '/v1/connections', made.token)).status, 401);
      assert.equal(
        (await projects(sam.workspace, 'POST', `/${made.id}/switch`, sam.token)).status,
        404,
      );
      // The first project cannot be deleted.
      const home = await projects(sam.workspace, 'DELETE', `/${sam.workspace}`, sam.token, {
        confirm: 'My project',
      });
      assert.equal(home.status, 409);
    });

    it('limits how many projects one person owns', async () => {
      // Sign-ins are rate limited, so this reuses a person from earlier tests.
      const tia = (await session('uid-bob', 'bob@example.com')).body.data;
      for (let n = 1; n < 5; n += 1) {
        const made = await projects(tia.workspace, 'POST', '', tia.token, { name: `P${n}` });
        assert.equal(made.status, 201, JSON.stringify(made.body));
      }
      const extra = await projects(tia.workspace, 'POST', '', tia.token, { name: 'One too many' });
      assert.equal(extra.status, 409);
    });

    it('lets an invited person add a shared project to their list', async () => {
      const uma = (await session('uid-alice', 'alice@example.com')).body.data;
      const vic = (await session('uid-bob', 'bob@example.com')).body.data;
      const shared = (
        await projects(uma.workspace, 'POST', '', uma.token, { name: 'Team site' })
      ).body.data;
      const invited = await inWorkspace(shared.id, 'POST', '/v1/admin/invites', shared.token, {
        email: 'bob@example.com',
        role: 'editor',
      });
      assert.equal(invited.status, 201, JSON.stringify(invited.body));
      // Vic is not a member until the project says so: nothing to switch to.
      assert.equal(
        (await projects(vic.workspace, 'POST', `/${shared.id}/switch`, vic.token)).status,
        404,
      );
      const joined = await gateway.call('POST', `/w/${shared.id}/v1/auth/firebase`, {
        token: null,
        body: { idToken: person('uid-bob', 'bob@example.com') },
      });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.equal(joined.body.data.role, 'editor');
      const remembered = await projects(shared.id, 'POST', '/remember', joined.body.data.token);
      assert.equal(remembered.status, 200, JSON.stringify(remembered.body));
      const list = await projects(vic.workspace, 'GET', '', vic.token);
      const entry = list.body.data.projects.find((item: { id: string }) => item.id === shared.id);
      assert.equal(entry.owner, false);
      assert.equal(entry.role, 'editor');
      const again = await projects(vic.workspace, 'POST', `/${shared.id}/switch`, vic.token);
      assert.equal(again.status, 200);
      assert.equal(again.body.data.role, 'editor');
      // A member cannot rename or delete what they do not own.
      assert.equal(
        (await projects(vic.workspace, 'PATCH', `/${shared.id}`, vic.token, { name: 'Mine' })).status,
        404,
      );
    });
  });
});

describe('workspaces on Firestore', () => {
  const firebase = new FakeFirebase();
  before(() => firebase.start());
  after(() => firebase.stop());

  it('keeps each workspace in its own collections', async () => {
    const fake = new FakeStateFirestore();
    const gateway = await startGateway(
      {
        seedDemo: false,
        firestore: { projectId: 'demo-sethucms', prefix: 'sethucms' },
        firebaseAuth: {
          projectId: 'demo-project',
          web: { apiKey: 'k', authDomain: 'demo-project.firebaseapp.com' },
          roles: { admin: ['team@example.com'], editor: [], viewer: [] },
          allowedDomains: [],
          providers: ['google.com'],
          sessionHours: 8,
          jwksUrl: `${firebase.url}/keys`,
        },
      },
      {
        firestore: fake,
        env: {
          SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
          SETHUCMS_WORKSPACES: 'open',
          SETHUCMS_WORKSPACE_SECRET: 'w'.repeat(40),
          SETHUCMS_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
          SETHUCMS_CURSOR_SECRET: Buffer.alloc(32, 8).toString('base64'),
          SETHUCMS_PREVIEW_SECRET: Buffer.alloc(32, 9).toString('base64'),
        },
      },
    );
    try {
      const sign = async (uid: string, email: string) =>
        (
          await gateway.call('POST', '/v1/workspaces/signin', {
            token: null,
            body: { idToken: firebase.token({ sub: uid, email, email_verified: true }) },
          })
        ).body.data;
      const alice = await sign('uid-a', 'alice@example.com');
      const bob = await sign('uid-b', 'bob@example.com');
      const made = await gateway.call('POST', `/w/${alice.workspace}/v1/admin/connections`, {
        token: alice.token,
        body: { name: 'Alice only', adapter: 'memory', mode: 'read_write', expose: 'all' },
      });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const bobList = await gateway.call('GET', `/w/${bob.workspace}/v1/connections`, { token: bob.token });
      assert.equal(bobList.body.data.length, 0);
      // Where the data lives: Alice's name appears only under Alice's prefix.
      for (const [collection, docs] of fake.data.entries()) {
        const mentionsAlice = JSON.stringify([...docs.entries()]).includes('Alice only');
        if (mentionsAlice) {
          assert.ok(
            collection.includes(alice.workspace),
            `Alice's data found in ${collection}`,
          );
        }
      }
      assert.ok([...fake.data.keys()].some((name) => name.includes(alice.workspace)));
      assert.ok([...fake.data.keys()].some((name) => name.includes(bob.workspace)));
    } finally {
      await gateway.close();
    }
  });
});
