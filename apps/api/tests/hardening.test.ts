// Covers operational hardening - API token expiry and rotation, the single-
// gateway data-folder lock, and migration history across restarts.

import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { acquireDataLock } from '../src/security/data-lock.js';
import { startGateway, type TestGateway } from './helpers.js';

// Status-only probe of /v1/me, so tests assert accept/reject without parsing
// bodies.
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
async function whoami(t: TestGateway, token: string): Promise<number> {
  return (await t.call('GET', '/v1/me', { token })).status;
}

// Expiry must be enforced per request, not just at creation, or leaked short-
// lived tokens would work forever.
describe('API token expiry and rotation', () => {
  it('a token can expire, and expiry is checked on every request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sethucms-exp-'));
    let t = await startGateway({ dataDir: dir, seedDemo: false });
    try {
      const made = await t.call('POST', '/v1/admin/tokens', {
        body: { name: 'CI', role: 'viewer', expiresInDays: 1 },
      });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.ok(Date.parse(made.body.data.expiresAt) > Date.now());
      const token = made.body.data.token as string;
      assert.equal(await whoami(t, token), 200);
      assert.ok(
        t.call &&
          (await t.call('GET', '/v1/admin/tokens')).body.data.some(
            (x: any) => x.id === made.body.data.id && x.expiresAt,
          ),
      );

      // Zero, negative, fractional, huge or string lifetimes must be refused,
      // or a token could be created that never expires or is already dead.
      for (const bad of [0, -1, 1.5, 4000, '7']) {
        assert.equal(
          (
            await t.call('POST', '/v1/admin/tokens', {
              body: { name: 'x', role: 'viewer', expiresInDays: bad },
            })
          ).status,
          400,
        );
      }

      // State is edited on disk while stopped, because waiting a day is not an
      // option; the reload must honour the stored date.
      // Move the expiry into the past, as time passing would.
      await t.close();
      const path = join(dir, 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      state.tokens[made.body.data.id].expiresAt = new Date(
        Date.now() - 1000,
      ).toISOString();
      writeFileSync(path, JSON.stringify(state));
      t = await startGateway({ dataDir: dir, seedDemo: false });
      assert.equal(await whoami(t, token), 401);
    } finally {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Rotation must not lock out running clients, but the old token must stop at
  // the end of the grace window.
  it('rotating gives a new token with the same role and lifetime; the old one works for the grace time only', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const made = (
        await t.call('POST', '/v1/admin/tokens', {
          body: { name: 'Site', role: 'editor', expiresInDays: 30 },
        })
      ).body.data;
      const rotated = await t.call(
        'POST',
        `/v1/admin/tokens/${made.id}/rotate`,
        { body: { graceMinutes: 10 } },
      );
      assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
      assert.notEqual(rotated.body.data.token, made.token);
      assert.equal(rotated.body.data.replaces, made.id);
      assert.equal(await whoami(t, rotated.body.data.token), 200);
      assert.equal(
        await whoami(t, made.token),
        200,
        'still works during the grace time',
      );

      const list = (await t.call('GET', '/v1/admin/tokens')).body.data;
      const old = list.find((x: any) => x.id === made.id);
      assert.ok(
        Date.parse(old.expiresAt) <= Date.now() + 10 * 60_000 + 5000,
        'the old token now ends within the grace time',
      );
      const fresh = list.find((x: any) => x.id === rotated.body.data.id);
      assert.equal(fresh.role, 'editor');
      assert.equal(fresh.name, 'Site');
      assert.ok(Date.parse(fresh.expiresAt) > Date.now() + 29 * 86_400_000);

      // Zero grace is the emergency path for a leaked token and must cut it off
      // immediately.
      // No grace: the old token stops at once.
      const second = await t.call(
        'POST',
        `/v1/admin/tokens/${rotated.body.data.id}/rotate`,
        { body: { graceMinutes: 0 } },
      );
      assert.equal(await whoami(t, rotated.body.data.token), 401);
      assert.equal(await whoami(t, second.body.data.token), 200);

      // The audit log must record the rotation but never the secret itself.
      // Missing, revoked and out-of-range requests are refused. The audit log records rotation without the token.
      assert.equal(
        (await t.call('POST', '/v1/admin/tokens/tok_nope/rotate', { body: {} }))
          .status,
        404,
      );
      assert.equal(
        (
          await t.call('POST', `/v1/admin/tokens/${made.id}/rotate`, {
            body: { graceMinutes: 5000 },
          })
        ).status,
        400,
      );
      const audit = JSON.stringify(
        (await t.call('GET', '/v1/admin/audit?limit=100')).body,
      );
      assert.match(audit, /token\.rotate/);
      assert.ok(!audit.includes(second.body.data.token));
    } finally {
      await t.close();
    }
  });

  // Rotating needs admin rights, and self-rotation with no grace would sever
  // the caller's own session.
  it('only admins can rotate, and you cannot cut off the token you are using', async () => {
    const t = await startGateway({ seedDemo: false });
    try {
      const editor = (
        await t.call('POST', '/v1/admin/tokens', {
          body: { name: 'e', role: 'editor' },
        })
      ).body.data;
      assert.equal(
        (
          await t.call('POST', `/v1/admin/tokens/${editor.id}/rotate`, {
            token: editor.token,
            body: {},
          })
        ).status,
        403,
      );
      const me = (await t.call('GET', '/v1/admin/tokens')).body.data.find(
        (x: any) => x.name === 'Bootstrap admin',
      );
      assert.equal(
        (
          await t.call('POST', `/v1/admin/tokens/${me.id}/rotate`, {
            body: { graceMinutes: 0 },
          })
        ).status,
        400,
      );
    } finally {
      await t.close();
    }
  });
});

// Two gateways on one data folder would overwrite each other's state.json.
describe('one gateway per data folder', () => {
  // The lock must be released on close, or a clean restart would be blocked.
  it('a second gateway on the same folder refuses to start; after closing, it can', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sethucms-lock-'));
    try {
      const first = await startGateway({ dataDir: dir, seedDemo: false });
      await assert.rejects(
        startGateway({ dataDir: dir, seedDemo: false }),
        /Another gateway appears to be using the data folder/,
      );
      await first.close();
      assert.ok(
        !existsSync(join(dir, 'gateway.lock')),
        'the lock is removed on close',
      );
      const again = await startGateway({ dataDir: dir, seedDemo: false });
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A crashed gateway leaves its lock behind; a stale lock is taken over, while
  // a fresh one still blocks unless forced.
  it('a lock left by a gateway that died is taken over once it is stale; force overrides a live one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sethucms-lock-'));
    try {
      const lock = await acquireDataLock(dir, { heartbeatMs: 1_000_000 });
      await assert.rejects(acquireDataLock(dir), /Another gateway/);
      // An old mtime simulates a dead holder whose heartbeat stopped.
      const old = new Date(Date.now() - 120_000);
      utimesSync(join(dir, 'gateway.lock'), old, old);
      const taken = await acquireDataLock(dir, { heartbeatMs: 1_000_000 });
      await taken.release();
      const forced = await acquireDataLock(dir, {
        force: true,
        heartbeatMs: 1_000_000,
      });
      await forced.release();
      await lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A failed start that kept the lock would block every retry until it went
  // stale.
  it('a gateway that fails while starting does not keep the lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sethucms-lock-'));
    try {
      writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 99 }));
      await assert.rejects(
        startGateway({ dataDir: dir, seedDemo: false }),
        /unknown version/,
      );
      assert.ok(!existsSync(join(dir, 'gateway.lock')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Job history must persist, but a job that was mid-run at shutdown can never
// finish and must not look active.
describe('migration history survives a restart', () => {
  it('keeps finished jobs, and marks a job that was running when the gateway stopped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sethucms-hist-'));
    let t = await startGateway({ dataDir: dir, seedDemo: false });
    try {
      const connect = async (name: string) => {
        const made = await t.call('POST', '/v1/admin/connections', {
          body: { name, adapter: 'memory', mode: 'read_write', expose: 'all' },
        });
        return made.body.data.id as string;
      };
      const [source, target] = [await connect('A'), await connect('B')];
      const started = await t.call('POST', '/v1/admin/migrations', {
        body: { source, target, onConflict: 'overwrite', preserveIds: true },
      });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      const id = started.body.data.id as string;
      // Polls until the job is done, so the saved snapshot reflects the
      // finished state.
      for (
        let i = 0;
        i < 200 &&
        (await t.call('GET', `/v1/admin/migrations/${id}`)).body.data.status ===
          'running';
        i += 1
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await t.close();

      const path = join(dir, 'state.json');
      const state = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(
        state.migrations[id].status,
        'completed',
        'the finished job was saved',
      );
      // History is stored on disk, so it must not contain copied record values.
      assert.ok(
        !JSON.stringify(state.migrations).includes('@example'),
        'no record values in the history',
      );

      // Writes a running job into the saved state to simulate a crash mid-
      // migration.
      // Pretend the gateway died in the middle of a second job.
      state.migrations['mig_dead'] = {
        ...state.migrations[id],
        id: 'mig_dead',
        status: 'running',
        finishedAt: undefined,
        startedAt: new Date().toISOString(),
      };
      state.migrations['mig_dead'].collections[0].state = 'running';
      writeFileSync(path, JSON.stringify(state));

      t = await startGateway({ dataDir: dir, seedDemo: false });
      assert.equal(
        (await t.call('GET', `/v1/admin/migrations/${id}`)).body.data.status,
        'completed',
      );
      const dead = (await t.call('GET', '/v1/admin/migrations/mig_dead')).body
        .data;
      assert.equal(dead.status, 'failed');
      assert.match(dead.message, /Run it again/);
      assert.equal(dead.collections[0].state, 'skipped');
      const listed = (
        await t.call('GET', '/v1/admin/migrations')
      ).body.data.map((j: any) => j.id);
      assert.ok(listed.includes(id) && listed.includes('mig_dead'));
      assert.match(
        JSON.stringify((await t.call('GET', '/v1/admin/audit?limit=200')).body),
        /migration\.interrupted/,
      );
      // A stale running job must not hold a lock that blocks new migrations.
      // The dead job does not block a new one.
      const again = await t.call('POST', '/v1/admin/migrations', {
        body: { source, target, preserveIds: true },
      });
      assert.equal(again.status, 202, JSON.stringify(again.body));
    } finally {
      await t.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
