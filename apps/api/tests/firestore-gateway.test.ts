// The gateway running on Firestore state, against the in-memory fake: a
// restart keeps its data, a second gateway is refused while the first is
// running, and nothing sensitive is stored in plain text. Also the settings
// read from the environment.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { configFromEnv } from '../src/config.js';
import { ADMIN_TOKEN, startGateway } from './helpers.js';
import { FakeStateFirestore } from './fake-state-firestore.js';

const secrets = (): NodeJS.ProcessEnv => ({
  SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN,
  SETHUCMS_VAULT_KEY: randomBytes(32).toString('base64'),
  SETHUCMS_CURSOR_SECRET: randomBytes(32).toString('base64'),
  SETHUCMS_PREVIEW_SECRET: randomBytes(32).toString('base64'),
});

const firestore = { projectId: 'demo-sethucms', prefix: 'sethucms' };

const notes = {
  name: 'Kept in Firestore',
  adapter: 'memory',
  mode: 'read_write',
  expose: 'all',
  config: {
    collections: [
      {
        name: 'notes',
        fields: [
          { name: 'id', type: 'string', primaryKey: true, required: true },
          { name: 'text', type: 'text' },
        ],
        relations: [],
      },
    ],
  },
};

describe('gateway state in Firestore', () => {
  it('keeps connections and tokens across a restart and writes an audit trail', async () => {
    const fake = new FakeStateFirestore();
    const env = secrets();
    const start = () =>
      startGateway(
        { seedDemo: false, firestore },
        { env, firestore: fake },
      );

    let t = await start();
    const created = await t.call('POST', '/v1/admin/connections', {
      body: notes,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id as string;
    const token = await t.call('POST', '/v1/admin/tokens', {
      body: { name: 'reader', role: 'viewer' },
    });
    assert.equal(token.status, 201);
    await t.close();

    t = await start();
    try {
      const back = await t.call('GET', `/v1/admin/connections/${id}`);
      assert.equal(back.status, 200, 'the connection is back after a restart');
      assert.equal(back.body.data.name, 'Kept in Firestore');
      const reader = await t.call('GET', '/v1/connections', {
        token: token.body.data.token as string,
      });
      assert.equal(reader.status, 200, 'the saved token still works');
      const audit = await t.call('GET', '/v1/admin/audit');
      assert.equal(audit.status, 200);
      assert.ok(JSON.stringify(audit.body).length > 50, 'audit entries exist');
    } finally {
      await t.close();
    }
  });

  it('refuses a second gateway while the first is running, then allows it after close', async () => {
    const fake = new FakeStateFirestore();
    const env = secrets();
    const options = { seedDemo: false, firestore };
    const first = await startGateway(options, { env, firestore: fake });
    await assert.rejects(
      () => startGateway(options, { env, firestore: fake }),
      /lease|already|running/i,
    );
    await first.close();
    const again = await startGateway(options, { env, firestore: fake });
    await again.close();
  });

  it('stores no draft text, vault key or token in plain text', async () => {
    const fake = new FakeStateFirestore();
    const env = secrets();
    const t = await startGateway(
      { seedDemo: false, firestore },
      { env, firestore: fake },
    );
    const created = await t.call('POST', '/v1/admin/connections', {
      body: notes,
    });
    const id = created.body.data.id as string;
    await t.call('POST', `/v1/connections/${id}/collections/notes/drafts`, {
      body: { values: { id: 'n1', text: 'a private draft sentence' } },
    });
    const made = await t.call('POST', '/v1/admin/tokens', {
      body: { name: 'x', role: 'editor' },
    });
    await t.close();

    const everything = JSON.stringify([...fake.data.entries()].map(([k, v]) => [k, [...v.entries()]]));
    assert.ok(everything.length > 100, 'something was stored');
    assert.ok(!everything.includes('a private draft sentence'), 'draft text');
    assert.ok(!everything.includes(ADMIN_TOKEN), 'admin token');
    assert.ok(!everything.includes(made.body.data.token as string), 'token');
    assert.ok(!everything.includes(env['SETHUCMS_VAULT_KEY'] as string), 'vault key');
  });
});

describe('Firestore settings from the environment', () => {
  const base = { NODE_ENV: 'production' };

  it('is off unless a project is named', () => {
    assert.equal(configFromEnv(base).firestore, undefined);
  });

  it('reads project, prefix, credentials and emulator host', () => {
    const config = configFromEnv({
      ...base,
      SETHUCMS_FIRESTORE_PROJECT: 'my-project-1',
      SETHUCMS_FIRESTORE_PREFIX: 'cms_prod',
      SETHUCMS_FIRESTORE_CREDENTIALS_JSON: '{"a":1}',
      SETHUCMS_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    });
    assert.deepEqual(config.firestore, {
      projectId: 'my-project-1',
      prefix: 'cms_prod',
      credentialsJson: '{"a":1}',
      emulatorHost: '127.0.0.1:8080',
    });
  });

  it('defaults the prefix', () => {
    const config = configFromEnv({
      ...base,
      SETHUCMS_FIRESTORE_PROJECT: 'my-project-1',
    });
    assert.equal(config.firestore?.prefix, 'sethucms');
  });

  it('rejects a bad project id, a bad prefix, and PostgreSQL state at the same time', () => {
    assert.throws(
      () => configFromEnv({ ...base, SETHUCMS_FIRESTORE_PROJECT: 'Bad Name!' }),
      /SETHUCMS_FIRESTORE_PROJECT/,
    );
    assert.throws(
      () =>
        configFromEnv({
          ...base,
          SETHUCMS_FIRESTORE_PROJECT: 'my-project-1',
          SETHUCMS_FIRESTORE_PREFIX: 'a/b',
        }),
      /SETHUCMS_FIRESTORE_PREFIX/,
    );
    assert.throws(
      () =>
        configFromEnv({
          ...base,
          SETHUCMS_FIRESTORE_PROJECT: 'my-project-1',
          SETHUCMS_STATE_URL: 'postgres://u:p@h:5432/d',
        }),
      /not both/,
    );
  });
});
