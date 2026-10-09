// Covers permission resolution: masking and hiding, probe prevention via query
// clauses, row filter enforcement, multi-role merging and write rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAccess,
  restrictQuery,
  maskRecord,
  assertWritable,
  applyRowFilter,
  parseQuery,
  eq,
  SethuError,
  type Permission,
} from '../src/index.js';
import { users } from './fixtures.js';

// Editor role: salary masked, email hidden, rows limited to one tenant.
const q = (o: object = {}) => parseQuery({ collection: 'users', ...o });
const editor: Permission = {
  action: 'read',
  fieldRules: { salary: { read: 'mask' }, email: { read: 'hide' } },
  rowFilter: eq('tenant', 'acme'),
};

// Deny by default; missing permission must not fall back to open access.
test('no permission => forbidden', () => {
  assert.throws(
    () => resolveAccess([], users, 'read'),
    (e) => (e as SethuError).code === 'FORBIDDEN',
  );
  assert.throws(() => resolveAccess([{ action: 'create' }], users, 'read'));
});

// Hidden fields must be dropped from output, not masked, so their existence is
// not revealed.
test('masking and hiding', () => {
  const a = resolveAccess([editor], users, 'read');
  const out = maskRecord(
    { id: 1, email: 'a@b.c', salary: 99, age: 3, extra: 'x' },
    a,
  );
  assert.deepEqual(out, { id: 1, salary: '***', age: 3 });
  const custom = resolveAccess(
    [
      {
        action: 'read',
        fieldRules: { salary: { read: 'mask', maskWith: null } },
      },
    ],
    users,
    'read',
  );
  assert.equal(maskRecord({ salary: 5 }, custom)['salary'], null);
});

// Filtering or sorting on a masked field would leak its value by binary search,
// so those clauses must be refused.
test('cannot probe masked/hidden fields through filter, sort or projection', () => {
  const a = resolveAccess([editor], users, 'read');
  assert.throws(
    () =>
      restrictQuery(
        q({ filter: { field: 'salary', op: 'gt', value: 100 } }),
        a,
      ),
    (e) => (e as SethuError).code === 'FORBIDDEN',
  );
  assert.throws(() => restrictQuery(q({ sort: [{ field: 'email' }] }), a));
  assert.throws(() => restrictQuery(q({ projection: ['email'] }), a));
  const ok = restrictQuery(q({ filter: eq('age', 3) }), a);
  assert.ok(!ok.projection!.includes('email'));
  assert.ok(ok.projection!.includes('salary'));
});

// A caller OR cannot widen the tenant scope; the row filter must be ANDed
// first.
test('row filter is ANDed and cannot be widened by caller filter', () => {
  const a = resolveAccess([editor], users, 'read');
  const r = restrictQuery(
    q({ filter: { or: [eq('tenant', 'other'), eq('age', 1)] } }),
    a,
  );
  assert.ok('and' in r.filter!);
  assert.deepEqual(
    (r.filter as { and: unknown[] }).and[0],
    eq('tenant', 'acme'),
  );
  assert.deepEqual(applyRowFilter(q(), a).filter, eq('tenant', 'acme'));
});

// Roles combine by union: the most permissive field rule wins, row filters OR
// together, and one unrestricted role lifts the filter.
test('multi-role merge: most permissive field access, OR row filters, unrestricted role lifts filter', () => {
  const a = resolveAccess(
    [
      editor,
      {
        action: 'read',
        fieldRules: { email: { read: 'allow' } },
        rowFilter: eq('tenant', 'beta'),
      },
    ],
    users,
    'read',
  );
  assert.equal(a.fieldRead.get('email'), 'allow');
  assert.ok('or' in a.rowFilter!);
  const b = resolveAccess([editor, { action: 'read' }], users, 'read');
  assert.equal(b.rowFilter, undefined);
  assert.equal(b.fieldRead.get('salary'), 'allow');
});

// Unknown fields and non-objects must be refused, or writes could target fields
// the schema never allowed.
test('write rules', () => {
  const a = resolveAccess(
    [{ action: 'update', fieldRules: { salary: { write: 'deny' } } }],
    users,
    'update',
  );
  assert.doesNotThrow(() => assertWritable({ age: 3 }, a));
  assert.throws(() => assertWritable({ salary: 1 }, a));
  assert.throws(() => assertWritable({ unknown: 1 }, a));
  assert.throws(() => assertWritable([], a));
});
