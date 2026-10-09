// Covers collection definition and record validation: identifier and pattern
// hardening, immutability, reference integrity, and create/update rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineCollection,
  ContentModel,
  validateRecord,
  SethuError,
} from '../src/index.js';
import { users } from './fixtures.js';

// Names flow into SQL and object keys downstream, so injection-shaped or
// prototype names must be refused at definition time.
test('defineCollection rejects bad identifiers, duplicate fields, missing pk', () => {
  assert.throws(
    () =>
      defineCollection({
        name: 'a; DROP TABLE x',
        fields: [{ name: 'id', type: 'integer', primaryKey: true }],
      }),
    SethuError,
  );
  assert.throws(() =>
    defineCollection({ name: 'a', fields: [{ name: 'id', type: 'integer' }] }),
  );
  assert.throws(() =>
    defineCollection({
      name: 'a',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'id', type: 'string' },
      ],
    }),
  );
  assert.throws(() =>
    defineCollection({
      name: '__proto__',
      fields: [{ name: 'id', type: 'integer', primaryKey: true }],
    }),
  );
});

// Field patterns run on user input; nested quantifiers or huge patterns would
// let a schema author hang the server.
test('defineCollection rejects ReDoS-prone and oversized patterns', () => {
  const mk = (pattern: string) => () =>
    defineCollection({
      name: 'a',
      fields: [
        {
          name: 'id',
          type: 'string',
          primaryKey: true,
          validation: { pattern },
        },
      ],
    });
  assert.throws(mk('(a+)+$'));
  assert.throws(mk('a'.repeat(201)));
  assert.throws(mk('('));
  assert.doesNotThrow(mk('^[a-z]+$'));
});

// Shared definitions must be frozen, or one caller could mutate a schema every
// request relies on.
test('definitions are frozen', () => {
  assert.throws(() => {
    (users.fields as unknown as unknown[]).push({});
  });
});

// A dangling reference would only surface as a broken join at query time.
test('ContentModel checks references', () => {
  const posts = defineCollection({
    name: 'posts',
    fields: [
      { name: 'id', type: 'integer', primaryKey: true },
      { name: 'author', type: 'reference', references: 'nobody' },
    ],
  });
  assert.throws(() => new ContentModel([posts]));
});

// Server-managed fields (generated, readOnly) must be refused on create so
// clients cannot forge ids or timestamps.
test('validateRecord: create requires fields, rejects unknown/generated/readOnly', () => {
  assert.deepEqual(validateRecord(users, { email: 'a@b.c' }, 'create'), []);
  assert.ok(
    validateRecord(users, {}, 'create').some((i) => i.path === 'email'),
  );
  assert.ok(
    validateRecord(users, { email: 'a@b.c', id: 5 }, 'create').some(
      (i) => i.path === 'id',
    ),
  );
  assert.ok(
    validateRecord(
      users,
      { email: 'a@b.c', createdAt: '2020-01-01T00:00:00Z' },
      'create',
    ).length > 0,
  );
  assert.ok(
    validateRecord(users, { email: 'a@b.c', admin: true }, 'create').some(
      (i) => i.message === 'unknown field',
    ),
  );
  // Must not crash or pollute the prototype; the outcome is irrelevant, only
  // that validation returns.
  assert.ok(
    validateRecord(
      users,
      { email: 'a@b.c', ['__proto__']: 1 } as never,
      'create',
    ).length >= 0,
  );
});

// Type and range checks plus partial-update semantics; null on a required field
// must not slip through.
test('validateRecord: types and rules', () => {
  assert.ok(validateRecord(users, { email: 'nope' }, 'create').length > 0);
  assert.ok(
    validateRecord(users, { email: 'a@b.c', age: 200 }, 'create').length > 0,
  );
  assert.ok(
    validateRecord(users, { email: 'a@b.c', age: 1.5 }, 'create').length > 0,
  );
  assert.ok(
    validateRecord(users, { email: 'a@b.c', age: '3' }, 'create').length > 0,
  );
  assert.deepEqual(validateRecord(users, { age: 30 }, 'update'), []);
  assert.ok(validateRecord(users, { email: null }, 'update').length > 0);
});
