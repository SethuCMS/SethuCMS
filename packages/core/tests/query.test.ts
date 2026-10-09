// Covers query parsing, schema validation and capability planning, focused on
// injection safety, hard limits and refusing unsupported queries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  validateQuery,
  checkCapabilities,
  planQuery,
  defineCapabilities,
  PRESETS,
  eq,
  and,
  or,
  not,
  collectFilterFields,
  SethuError,
} from '../src/index.js';
import { users } from './fixtures.js';

// Shorthand that builds a query for the users collection.
const q = (o: object) => parseQuery({ collection: 'users', ...o });

test('parseQuery applies defaults and normalises', () => {
  const r = q({ filter: eq('age', 3) });
  assert.equal(r.page.limit, 50);
  assert.deepEqual(r.filter, { field: 'age', op: 'eq', value: 3 });
});

// Operator objects like $ne would turn into NoSQL injection on document stores,
// so non-scalar values must be rejected.
test('parseQuery rejects NoSQL operator injection shapes', () => {
  assert.throws(
    () => q({ filter: { field: 'email', op: 'eq', value: { $ne: null } } }),
    SethuError,
  );
  assert.throws(() =>
    q({ filter: { field: 'email', op: 'eq', value: ['a'] } }),
  );
  assert.throws(() => q({ filter: { $where: 'sleep(1000)' } }));
  assert.throws(() =>
    q({ filter: { field: 'email', op: 'eq', value: 'x', extra: 1 } }),
  );
});

// Names reach SQL and object lookups, so unsafe identifiers and prototype keys
// must be rejected at parse time.
test('parseQuery rejects SQL-ish identifiers and prototype keys', () => {
  assert.throws(() => q({ filter: eq('email; DROP TABLE users', 1) }));
  assert.throws(() => q({ sort: [{ field: 'a b' }] }));
  assert.throws(() => q({ projection: ['__proto__'] }));
  assert.throws(() =>
    parseQuery(
      JSON.parse(
        '{"collection":"users","filter":{"__proto__":{},"field":"a","op":"eq","value":1}}',
      ),
    ),
  );
  assert.throws(() => parseQuery({ collection: 'constructor' }));
});

// Limits bound the cost of a single request; each one could be a DoS vector if
// lost.
test('parseQuery enforces limits', () => {
  assert.throws(() => q({ page: { limit: 501 } }));
  assert.throws(() => q({ page: { limit: 0 } }));
  assert.throws(() => q({ page: { offset: 10 } }));
  assert.throws(() => q({ page: { cursor: 'x'.repeat(5000) } }));
  assert.throws(() =>
    q({ filter: { in: 1, field: 'age', op: 'in', value: Array(201).fill(1) } }),
  );
  assert.throws(() =>
    q({ filter: { field: 'age', op: 'in', value: Array(201).fill(1) } }),
  );
  let deep: object = eq('age', 1);
  for (let i = 0; i < 10; i++) {
    deep = { not: deep };
  }
  assert.throws(() => q({ filter: deep }));
  assert.throws(() => q({ filter: { and: Array(101).fill(eq('age', 1)) } }));
  assert.throws(() => q({ sort: Array(5).fill({ field: 'age' }) }));
});

// The collection definition is the allowlist; unknown fields and mistyped
// values must be reported before reaching the backend.
test('validateQuery uses the collection as an allowlist and checks types', () => {
  assert.deepEqual(validateQuery(q({ filter: eq('age', 3) }), users), []);
  assert.ok(validateQuery(q({ filter: eq('ghost', 3) }), users).length > 0);
  assert.ok(validateQuery(q({ filter: eq('age', 'x') }), users).length > 0);
  assert.ok(
    validateQuery(q({ filter: { field: 'tags', op: 'gt', value: 1 } }), users)
      .length > 0,
  );
  assert.ok(validateQuery(q({ sort: [{ field: 'tags' }] }), users).length > 0);
  assert.ok(validateQuery(q({ projection: ['ghost'] }), users).length > 0);
});

// Backends differ in OR, multi-field inequality and sorting; unsupported
// combinations must be flagged rather than run wrongly.
test('checkCapabilities: OR, inequality, sort', () => {
  const dyn = PRESETS.dynamodb;
  assert.ok(
    checkCapabilities(q({ filter: or(eq('age', 1), eq('age', 2)) }), dyn, users)
      .violations.length > 0,
  );
  const fs = PRESETS.firestore;
  const two = and(
    { field: 'age', op: 'gt', value: 1 },
    { field: 'salary', op: 'lt', value: 5 },
  );
  assert.ok(
    checkCapabilities(q({ filter: two }), fs, users).violations.length > 0,
  );
  assert.equal(
    checkCapabilities(q({ filter: two }), PRESETS.sql, users).violations.length,
    0,
  );
  assert.ok(
    checkCapabilities(q({ sort: [{ field: 'age' }] }), dyn, users).violations
      .length > 0,
  );
  assert.equal(
    checkCapabilities(q({ sort: [{ field: 'id' }] }), dyn, users).violations
      .length,
    0,
  );
  assert.ok(
    checkCapabilities(q({ sort: [{ field: 'age' }] }), fs, users).notes.length >
      0,
  );
  assert.ok(
    checkCapabilities(
      q({ filter: not({ field: 'age', op: 'ne', value: 1 }) }),
      defineCapabilities(),
      users,
    ).violations.length > 0,
  );
});

// Silent fallback to a degraded plan would return different results than asked
// for, so planning must throw.
test('planQuery throws CAPABILITY_UNSUPPORTED, never degrades silently', () => {
  try {
    planQuery(
      q({ filter: or(eq('age', 1), eq('age', 2)) }),
      users,
      PRESETS.dynamodb,
    );
    assert.fail();
  } catch (e) {
    assert.equal((e as SethuError).code, 'CAPABILITY_UNSUPPORTED');
  }
  assert.deepEqual(
    collectFilterFields(
      and(eq('a', 1), or(eq('b', 2), not(eq('a', 3)))),
    ).sort(),
    ['a', 'b'],
  );
});
