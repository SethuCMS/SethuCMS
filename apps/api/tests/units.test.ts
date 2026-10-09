// Covers the security building blocks in isolation - vault encryption, preview
// tokens, SSRF network guard, rate limiter and idempotency store.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { IdempotencyStore } from '../src/security/idempotency.js';
import { NetworkGuard } from '../src/security/network-guard.js';
import { PreviewTokens } from '../src/security/preview-token.js';
import { RateLimiter } from '../src/security/rate-limit.js';
import { Vault } from '../src/security/vault.js';

// Credentials at rest depend on this; a ciphertext reused across values would
// leak equality.
describe('vault', () => {
  const vault = new Vault(randomBytes(32));

  it('round-trips and never repeats a ciphertext', () => {
    const a = vault.encrypt('secret', 'conn_1');
    const b = vault.encrypt('secret', 'conn_1');
    assert.notEqual(a, b);
    assert.equal(vault.decrypt(a, 'conn_1'), 'secret');
    assert.ok(!a.includes('secret'));
  });

  // Binding to a label stops a secret copied between connections from
  // decrypting; tampering must fail authentication.
  it('rejects a different label, a different key and edited data', () => {
    const sealed = vault.encrypt('secret', 'conn_1');
    assert.throws(() => vault.decrypt(sealed, 'conn_2'));
    assert.throws(() => new Vault(randomBytes(32)).decrypt(sealed, 'conn_1'));
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => vault.decrypt(parts.join('.'), 'conn_1'));
  });
});

// Preview links are bearer credentials, so forgery, wrong-key and expired
// tokens must all be rejected. Time is injected to avoid sleeping.
describe('preview tokens', () => {
  it('verify, expire and reject forgeries', () => {
    let now = 1000;
    const tokens = new PreviewTokens(randomBytes(32), () => now);
    const { token } = tokens.sign({ draftId: 'd1', principalId: 'p1' }, 60);
    assert.deepEqual(tokens.verify(token)?.draftId, 'd1');
    assert.equal(tokens.verify(token + 'x'), null);
    assert.equal(
      new PreviewTokens(randomBytes(32), () => now).verify(token),
      null,
    );
    now += 61;
    assert.equal(tokens.verify(token), null);
  });
});

// SSRF defence for user-supplied database hosts.
describe('network guard', () => {
  const resolveTo = (address: string) => async () => [address];

  // Cloud metadata endpoints must stay blocked even when private networks are
  // allowed.
  it('always blocks link-local and metadata addresses', async () => {
    for (const address of ['169.254.169.254', '169.254.1.1', 'fe80::1']) {
      await assert.rejects(
        new NetworkGuard({
          allowPrivateNetworks: true,
          resolve: resolveTo(address),
        }).assertAllowed('x.test'),
      );
    }
  });

  // Loopback, RFC1918, ULA, CGNAT and IPv4-mapped IPv6 forms are the usual
  // bypasses; the loop also checks the opt-in path still works.
  it('blocks private ranges unless allowed', async () => {
    for (const address of [
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.1.1',
      '127.0.0.1',
      '::1',
      'fd12::1',
      '::ffff:10.0.0.1',
      '100.64.0.1',
    ]) {
      await assert.rejects(
        new NetworkGuard({
          allowPrivateNetworks: false,
          resolve: resolveTo(address),
        }).assertAllowed('x.test'),
        /./,
        address,
      );
      await new NetworkGuard({
        allowPrivateNetworks: true,
        resolve: resolveTo(address),
      })
        .assertAllowed('x.test')
        .catch(() => assert.fail(address));
    }
    await new NetworkGuard({
      allowPrivateNetworks: false,
      resolve: resolveTo('93.184.216.34'),
    }).assertAllowed('example.test');
  });

  // A hostname with one public and one private record could be rebound to the
  // private one, so every address is checked.
  it('checks every address a name resolves to', async () => {
    const guard = new NetworkGuard({
      allowPrivateNetworks: false,
      resolve: async () => ['93.184.216.34', '10.0.0.1'],
    });
    await assert.rejects(guard.assertAllowed('mixed.test'));
  });

  // IP literals skip DNS; a DNS failure must deny rather than allow.
  it('checks IP literals directly and fails closed on DNS errors', async () => {
    const guard = new NetworkGuard({
      allowPrivateNetworks: false,
      resolve: async () => {
        throw new Error('nx');
      },
    });
    await assert.rejects(guard.assertAllowed('169.254.169.254'));
    await assert.rejects(guard.assertAllowed('nope.test'));
  });
});

// Per-caller token bucket, with an injected clock.
describe('rate limiter', () => {
  it('allows a burst, then asks callers to wait, then refills', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 1, () => now);
    assert.deepEqual(
      [1, 2, 3].map(() => limiter.take('a')),
      [0, 0, 0],
    );
    assert.ok(limiter.take('a') >= 1);
    assert.equal(limiter.take('b'), 0); // other callers are unaffected
    now += 2000;
    assert.equal(limiter.take('a'), 0);
  });
});

// Retried POSTs must not run twice, but the same key on a different payload is
// a client bug.
describe('idempotency store', () => {
  it('runs the work once per key and rejects key reuse for other requests', async () => {
    const store = new IdempotencyStore();
    let runs = 0;
    const work = async () => ({ status: 201, body: { n: ++runs } });
    const [a, b] = await Promise.all([
      store.run('c', 'k1', 'POST /x', { a: 1 }, work),
      store.run('c', 'k1', 'POST /x', { a: 1 }, work),
    ]);
    assert.equal(runs, 1);
    assert.deepEqual(a, b);
    await assert.rejects(store.run('c', 'k1', 'POST /x', { a: 2 }, work));
    await store.run('other', 'k1', 'POST /x', { a: 2 }, work); // keys are per caller
    assert.equal(runs, 2);
  });

  // Caching a 500 would make a transient failure permanent for that key.
  it('does not remember server errors', async () => {
    const store = new IdempotencyStore();
    let runs = 0;
    const work = async () => ({ status: ++runs === 1 ? 500 : 200, body: null });
    await store.run('c', 'k', 'op', null, work);
    assert.equal((await store.run('c', 'k', 'op', null, work)).status, 200);
  });

  // Empty or whitespace keys would collide or break header handling.
  it('rejects unusable keys', async () => {
    const store = new IdempotencyStore();
    await assert.rejects(
      store.run('c', '', 'op', null, async () => ({ status: 200, body: null })),
    );
    await assert.rejects(
      store.run('c', 'has space', 'op', null, async () => ({
        status: 200,
        body: null,
      })),
    );
  });
});
