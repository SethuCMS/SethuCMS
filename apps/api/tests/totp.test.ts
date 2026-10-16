import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  base32Decode,
  base32Encode,
  codeFor,
  newSecret,
  otpauthUri,
  stepAt,
  verifyCode,
} from '../src/security/totp.js';
import { startGateway, tokenFor, type TestGateway } from './helpers.js';

describe('totp codes', () => {
  // RFC 6238 test key and SHA-1 results (last six digits of the 8-digit values).
  const key = Buffer.from('12345678901234567890');
  it('matches the RFC 6238 vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ];
    for (const [seconds, code] of vectors) {
      assert.equal(codeFor(key, stepAt(seconds * 1000)), code);
    }
  });

  it('round-trips base32', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.deepEqual(base32Decode('mzxw 6ytb-oi'), Buffer.from('foobar'));
    assert.equal(base32Decode('not base32!'), null);
  });

  it('accepts one step of drift, refuses older codes and reuse', () => {
    const secret = newSecret();
    const bytes = base32Decode(secret) as Buffer;
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    assert.equal(verifyCode(secret, codeFor(bytes, step), now), step);
    assert.equal(verifyCode(secret, codeFor(bytes, step - 1), now), step - 1);
    assert.equal(verifyCode(secret, codeFor(bytes, step - 2), now), null);
    assert.equal(verifyCode(secret, codeFor(bytes, step), now, step), null);
    assert.equal(verifyCode(secret, '12345', now), null);
    assert.equal(verifyCode(secret, 'abcdef', now), null);
  });

  it('builds a link authenticator apps understand', () => {
    const link = otpauthUri('ABCDEFGH', 'asha');
    assert.ok(link.startsWith('otpauth://totp/SethuCMS:asha?'));
    assert.ok(link.includes('secret=ABCDEFGH'));
  });
});

describe('sign-in with an authenticator code', () => {
  let t: TestGateway;
  // Sign-in is rate limited per address (a burst of 10), so these tests share
  // calls: ten sign-in attempts in all.
  let ashaId = '';
  let ashaSession = '';
  before(async () => {
    t = await startGateway();
  });
  after(() => t.close());

  const codeNow = (secret: string): string =>
    codeFor(base32Decode(secret) as Buffer, stepAt(Date.now()));
  const add = async (username: string, role = 'editor') =>
    (await t.call('POST', '/v1/admin/people', { body: { username, role } }))
      .body.data as { id: string; secret: string; otpauthUri: string };
  const login = (username: string, code: string) =>
    t.call('POST', '/v1/auth/totp/login', {
      token: null,
      body: { username, code },
    });

  it('adds a person, shows the key once and signs in with a code', async () => {
    const person = await add('asha');
    ashaId = person.id;
    assert.match(person.secret, /^[A-Z2-7]{32}$/);
    assert.ok(person.otpauthUri.startsWith('otpauth://totp/'));

    const list = await t.call('GET', '/v1/admin/people');
    assert.equal(list.body.data.length >= 1, true);
    assert.equal(JSON.stringify(list.body).includes(person.secret), false);

    const signedIn = await login('Asha', codeNow(person.secret)); // 1
    assert.equal(signedIn.status, 200);
    ashaSession = signedIn.body.data.token;
    const me = await t.call('GET', '/v1/me', { token: ashaSession });
    assert.equal(me.body.data.role, 'editor');
    assert.equal(me.body.data.name, 'asha');
  });

  it('refuses a code used a second time', async () => {
    const person = await add('ravi');
    const code = codeNow(person.secret);
    assert.equal((await login('ravi', code)).status, 200); // 2
    assert.equal((await login('ravi', code)).status, 401); // 3
  });

  it('locks a person out after five wrong codes', async () => {
    const person = await add('locked');
    const unknown = await login('nobody', '000000'); // 4
    const first = await login('locked', '111111'); // 5
    assert.equal(unknown.status, 401);
    assert.equal(first.status, 401);
    // Unknown name and wrong code read the same, so names cannot be probed.
    assert.equal(unknown.body.error.message, first.body.error.message);
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await login('locked', '111111')).status, 401); // 6-9
    }
    // Even the right code is refused while locked.
    const blocked = await login('locked', codeNow(person.secret)); // 10
    assert.equal(blocked.status, 429);
  });

  it('only admins manage people, and removing one ends their sessions', async () => {
    const editor = await tokenFor(t, 'editor');
    const denied = await t.call('POST', '/v1/admin/people', {
      token: editor,
      body: { username: 'sneaky', role: 'admin' },
    });
    assert.equal(denied.status, 403);

    assert.equal((await t.call('GET', '/v1/me', { token: ashaSession })).status, 200);
    assert.equal((await t.call('DELETE', `/v1/admin/people/${ashaId}`)).status, 204);
    assert.equal((await t.call('GET', '/v1/me', { token: ashaSession })).status, 401);
  });

  it('rejects a duplicate or invalid username', async () => {
    await add('dup');
    const again = await t.call('POST', '/v1/admin/people', {
      body: { username: 'dup', role: 'viewer' },
    });
    assert.equal(again.status, 409);
    const bad = await t.call('POST', '/v1/admin/people', {
      body: { username: 'x', role: 'viewer' },
    });
    assert.equal(bad.status, 400);
  });

  it('tells the admin app when authenticator sign-in is available', async () => {
    const config = await t.call('GET', '/v1/auth/config', { token: null });
    assert.equal(config.body.totp.enabled, true);
  });
});
