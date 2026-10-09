// Covers on-disk state - restart survival, encryption and file modes, first-run
// admin token, and production start-up checks.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createGateway } from '../src/gateway.js';
import { silentLogger } from '../src/logger.js';
import { ADMIN_TOKEN, startGateway } from './helpers.js';

describe('saving state to disk', () => {
  // A restart must restore connections and drafts, yet nothing sensitive may be
  // readable in the files on disk.
  it('survives a restart, keeps secrets encrypted and files private', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-'));
    try {
      let t = await startGateway({ dataDir: dir, seedDemo: false });
      const created = await t.call('POST', '/v1/admin/connections', {
        body: {
          name: 'Persisted',
          adapter: 'memory',
          mode: 'read_write',
          expose: 'all',
          config: {
            collections: [
              {
                name: 'notes',
                fields: [
                  {
                    name: 'id',
                    type: 'string',
                    primaryKey: true,
                    required: true,
                  },
                  { name: 'text', type: 'text' },
                ],
                relations: [],
              },
            ],
          },
        },
      });
      assert.equal(created.status, 201);
      const id = created.body.data.id;
      await t.call('POST', `/v1/connections/${id}/collections/notes/drafts`, {
        body: { values: { id: 'n1', text: 'a private draft' } },
      });
      const first = await t.call(
        'GET',
        `/v1/connections/${id}/collections/notes/records`,
      );
      assert.equal(first.status, 200);
      await t.close();

      // Reads raw files after close; a plaintext draft or raw token here would
      // mean secrets reach disk unencrypted.
      const state = await readFile(join(dir, 'state.json'), 'utf8');
      assert.ok(
        !state.includes('a private draft'),
        'draft contents must be encrypted at rest',
      );
      assert.ok(
        !state.includes(ADMIN_TOKEN),
        'tokens are stored as hashes only',
      );
      // Group/other permission bits must be zero, or other local users could
      // read secrets and the audit log.
      for (const file of ['state.json', 'secrets.json', 'audit.log']) {
        assert.equal(
          (await stat(join(dir, file))).mode & 0o077,
          0,
          `${file} must be owner-only`,
        );
      }

      // Same directory, fresh gateway - proves state is loaded from disk, not
      // kept in memory.
      t = await startGateway({ dataDir: dir, seedDemo: false });
      const list = await t.call('GET', '/v1/connections');
      assert.equal(list.body.data[0].id, id);
      const drafts = await t.call(
        'GET',
        `/v1/connections/${id}/collections/notes/drafts`,
      );
      assert.equal(drafts.body.data[0].values.text, 'a private draft');
      const audit = await t.call('GET', '/v1/admin/audit');
      assert.ok(
        audit.body.data.some(
          (entry: any) => entry.operation === 'connection.create',
        ),
      );
      await t.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The one-time token must appear on first start only; regenerating it would
  // lock out the operator, and repeating it would leak it.
  it('generates an admin token on first start and none afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-'));
    const config = {
      dataDir: dir,
      production: false,
      allowedOrigins: [],
      allowPrivateNetworks: true,
      trustProxy: false,
      adminDir: undefined,
      seedDemo: false,
      host: '127.0.0.1',
      port: 0,
    };
    try {
      const first = await createGateway({
        config,
        env: {},
        logger: silentLogger,
      });
      assert.match(first.generatedAdminToken ?? '', /^adb_/);
      await first.close();
      const second = await createGateway({
        config,
        env: {},
        logger: silentLogger,
      });
      assert.equal(second.generatedAdminToken, undefined);
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Production must fail closed - missing keys or admin token would otherwise
  // run with weak or ephemeral secrets.
  it('refuses to start in production without secrets or an admin token', async () => {
    const config = {
      dataDir: undefined,
      production: true,
      allowedOrigins: [],
      allowPrivateNetworks: false,
      trustProxy: false,
      adminDir: undefined,
      seedDemo: false,
      host: '127.0.0.1',
      port: 0,
    };
    await assert.rejects(
      createGateway({ config, env: {}, logger: silentLogger }),
      /Missing secrets/,
    );
    const secret = Buffer.alloc(32, 7).toString('base64');
    const env = {
      SETHUCMS_VAULT_KEY: secret,
      SETHUCMS_CURSOR_SECRET: secret,
      SETHUCMS_PREVIEW_SECRET: secret,
    };
    await assert.rejects(
      createGateway({ config, env, logger: silentLogger }),
      /SETHUCMS_ADMIN_TOKEN/,
    );
    const ok = await createGateway({
      config,
      env: { ...env, SETHUCMS_ADMIN_TOKEN: 'a'.repeat(40) },
      logger: silentLogger,
    });
    await ok.close();
  });
});
