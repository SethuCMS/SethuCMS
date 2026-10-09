// Covers shared utilities: secret redaction, change diffs, error mapping,
// capability presets, canonical JSON and value type checks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redact,
  redactConnectionString,
  diffRecords,
  toApiError,
  errors,
  HTTP_STATUS,
  ERROR_CODES,
  defineCapabilities,
  applyReadOnly,
  assertWritesAllowed,
  PRESETS,
  canonicalJson,
  isValueOfType,
} from '../src/index.js';

// Secrets leaking into logs or audit trails is the failure; nested, array and
// connection-string shapes are the easy ones to miss.
test('redact removes secrets by key and in connection strings', () => {
  const r = redact({
    host: 'h',
    password: 'p',
    nested: { apiKey: 'k', url: 'postgres://u:hunter2@h/db?sslmode=require' },
    list: [{ token: 't' }],
  }) as any;
  assert.equal(r.password, '[REDACTED]');
  assert.equal(r.nested.apiKey, '[REDACTED]');
  assert.ok(!r.nested.url.includes('hunter2'));
  assert.equal(r.list[0].token, '[REDACTED]');
  assert.ok(
    !redactConnectionString('Server=x;Password=abc;User=u').includes('abc'),
  );
  // A __proto__ key in parsed JSON must not survive redaction or pollute
  // output.
  assert.ok(
    !JSON.stringify(redact(JSON.parse('{"__proto__":{"x":1},"a":1}'))).includes(
      '"x"',
    ),
  );
});

// Audit diffs must hold only changed keys, and still redact, or secrets leak
// via history.
test('diffRecords only includes changes and redacts', () => {
  const d = diffRecords(
    { a: 1, b: 2, password: 'x' },
    { a: 1, b: 3, password: 'y' },
  );
  assert.deepEqual(d, {
    before: { b: 2, password: '[REDACTED]' },
    after: { b: 3, password: '[REDACTED]' },
  });
  assert.deepEqual(diffRecords(null, { a: 1 }), {
    before: {},
    after: { a: 1 },
  });
});

// Internal errors must never expose their message or stack to API clients.
test('errors: HTTP mapping and INTERNAL hiding', () => {
  for (const c of ERROR_CODES) {
    assert.ok(HTTP_STATUS[c] >= 400);
  }
  assert.equal(toApiError(errors.notFound()).status, 404);
  assert.equal(
    toApiError(errors.validation('bad', [{ path: 'a', message: 'x' }])).status,
    400,
  );
  const hidden = toApiError(
    errors.internal('db password=abc leaked', { stack: 'secret' }),
  );
  assert.equal(hidden.status, 500);
  assert.ok(!JSON.stringify(hidden).includes('abc'));
  assert.equal(toApiError(new Error('boom')).error.message, 'Internal error');
});

// Backends must start with no capabilities; a permissive default would let
// unsupported queries silently misbehave.
test('capabilities are restrictive by default and read-only disables writes', () => {
  const d = defineCapabilities();
  assert.equal(d.writes, false);
  assert.equal(d.filters.or, false);
  assert.equal(d.pagination.cursor, true);
  assert.equal(applyReadOnly(PRESETS.sql, true).writes, false);
  assert.equal(applyReadOnly(PRESETS.sql, false).writes, true);
  assert.throws(
    () => assertWritesAllowed(applyReadOnly(PRESETS.sql, true)),
    (e: any) => e.code === 'READ_ONLY',
  );
});

// Canonical JSON must be key-order stable (it is hashed or signed); type checks
// guard stored data from bad coercions.
test('util and type checks', () => {
  assert.equal(
    canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }),
    '{"a":[2,{"d":1}],"b":1}',
  );
  assert.ok(isValueOfType('datetime', '2024-01-01T10:00:00Z'));
  assert.ok(!isValueOfType('datetime', 'yesterday'));
  assert.ok(isValueOfType('geopoint', { lat: 1, lng: 2 }));
  assert.ok(!isValueOfType('geopoint', { lat: 100, lng: 2 }));
  assert.ok(!isValueOfType('integer', Number.MAX_SAFE_INTEGER + 2));
  assert.ok(!isValueOfType('json', { a: () => 1 }));
  // Foreign keys can be text or integer ids, but not floats or objects.
  // references hold the other record's key: text or a whole number
  assert.ok(isValueOfType('reference', 'abc'));
  assert.ok(isValueOfType('reference', 7));
  assert.ok(!isValueOfType('reference', 1.5));
  assert.ok(!isValueOfType('reference', { id: 1 }));
});
