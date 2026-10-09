// Covers signed pagination cursors: round trip, tamper resistance, query
// binding, expiry and signing-key rotation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorCodec, parseQuery, SethuError } from '../src/index.js';

// Two distinct 32-byte keys, to prove which key signed or verified a cursor.
const s1 = new Uint8Array(32).fill(1);
const s2 = new Uint8Array(32).fill(2);
const q = (o: object = {}) => parseQuery({ collection: 'users', ...o });

// Baseline: a cursor decodes for the same query it was issued for.
test('round trip', async () => {
  const c = new CursorCodec({ secrets: [s1] });
  const cur = await c.encode(q(), { after: 42 });
  assert.deepEqual(await c.decode(q({ page: { limit: 10 } }), cur), {
    after: 42,
  });
});

// Weak HMAC keys make cursors forgeable.
test('rejects short secrets', () => {
  assert.throws(() => new CursorCodec({ secrets: [new Uint8Array(8)] }));
  assert.throws(() => new CursorCodec({ secrets: [] }));
});

// Every failure must give the same message, so attackers cannot learn which
// check (signature, shape, binding) rejected them.
test('tampered, malformed and rebound cursors fail with the same error', async () => {
  const c = new CursorCodec({ secrets: [s1] });
  const cur = await c.encode(q(), { after: 1 });
  const [body, sig] = cur.split('.') as [string, string];
  const forged =
    Buffer.from(JSON.stringify({ v: 1, q: 'x', k: { after: 0 } })).toString(
      'base64url',
    ) +
    '.' +
    sig;
  // Collects messages across all bad cursors; asserted below to be a single
  // value.
  const msgs = new Set<string>();
  for (const bad of [
    forged,
    body + '.AAAA',
    'garbage',
    '',
    body,
    cur + 'x',
    'a.b.c',
  ]) {
    await assert.rejects(c.decode(q(), bad), (e: unknown) => {
      msgs.add((e as SethuError).message);
      return e instanceof SethuError;
    });
  }
  // A cursor must be bound to its query; replaying it on another filter or
  // collection could expose rows outside the intended page.
  // different filter => different query
  await assert.rejects(
    c.decode(q({ filter: { field: 'age', op: 'eq', value: 1 } }), cur),
  );
  await assert.rejects(c.decode(parseQuery({ collection: 'posts' }), cur));
  assert.equal(msgs.size, 1);
});

// Fake clock avoids sleeping; expired cursors must stop working to limit
// replay.
test('expiry', async () => {
  let t = 1_000_000;
  const c = new CursorCodec({ secrets: [s1], ttlSeconds: 60, now: () => t });
  const cur = await c.encode(q(), 1);
  t += 30_000;
  assert.equal(await c.decode(q(), cur), 1);
  t += 31_000;
  await assert.rejects(c.decode(q(), cur));
});

// Rotation must not strand in-flight cursors, yet new cursors must be signed
// with the first (newest) key only.
test('key rotation: old cursors verify, new ones sign with the first key', async () => {
  const old = new CursorCodec({ secrets: [s1] });
  const cur = await old.encode(q(), 'old');
  const rotated = new CursorCodec({ secrets: [s2, s1] });
  assert.equal(await rotated.decode(q(), cur), 'old');
  const fresh = await rotated.encode(q(), 'new');
  await assert.rejects(old.decode(q(), fresh));
  await assert.rejects(new CursorCodec({ secrets: [s2] }).decode(q(), cur));
});
