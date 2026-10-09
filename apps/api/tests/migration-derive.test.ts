// Covers planning for createMissing - deriving a target collection from the
// source, including renames, references, ids and json fields.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defineCollection } from '@sethucms/core';
import {
  deriveTarget,
  parseMigrationRequest,
  planCollection,
} from '../src/migration/plan.js';

const customers = defineCollection({
  name: 'customers',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    {
      name: 'name',
      type: 'string',
      required: true,
      validation: { maxLength: 50 },
    },
  ],
});
const orders = defineCollection({
  name: 'orders',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    { name: 'customer', type: 'reference', references: 'customers' },
    { name: 'tags', type: 'array', lossy: true },
  ],
});
// Lookup of all source collections, as the planner receives it.
const all = new Map([
  [customers.name, customers],
  [orders.name, orders],
]);

// createMissing creates schema in the target, so a loose truthy value like
// "yes" must not enable it.
describe('creating missing collections: planning', () => {
  it('accepts createMissing and rejects non-booleans', () => {
    assert.equal(
      parseMigrationRequest({ source: 'a', target: 'b' }).createMissing,
      false,
    );
    assert.equal(
      parseMigrationRequest({ source: 'a', target: 'b', createMissing: true })
        .createMissing,
      true,
    );
    assert.throws(() =>
      parseMigrationRequest({ source: 'a', target: 'b', createMissing: 'yes' }),
    );
  });

  // The derived schema must stay consistent with renames, otherwise references
  // would point at collections or fields that do not exist.
  it('keeps fields, key and rules; renames follow the request; references follow renamed collections', () => {
    const copied = new Map([
      ['customers', 'clients'],
      ['orders', 'sales'],
    ]);
    const made = deriveTarget(
      { from: 'orders', to: 'sales', fields: { customer: 'client' } },
      orders,
      copied,
      all,
    );
    assert.equal(made.name, 'sales');
    assert.deepEqual(
      made.fields.map((f) => f.name),
      ['id', 'client', 'tags'],
    );
    assert.equal(made.fields[1]!.references, 'clients');
    assert.equal(made.fields[0]!.generated, true);
    // Lossy is a source-only marker; carrying it over would warn about data the
    // new target stores faithfully.
    assert.equal(made.fields[2]!.lossy, undefined);
    assert.deepEqual(made.relations, []);
    assert.equal(
      deriveTarget(
        { from: 'customers', to: 'clients', fields: {} },
        customers,
        copied,
        all,
      ).fields[1]!.validation?.maxLength,
      50,
    );
  });

  // A reference to a collection that is not being copied would dangle, so it
  // degrades to the key type.
  it('a reference to a collection that is not being created becomes a plain value of the key type', () => {
    const made = deriveTarget(
      { from: 'orders', to: 'orders', fields: {} },
      orders,
      new Map([['orders', 'orders']]),
      all,
    );
    assert.equal(made.fields[1]!.type, 'integer');
    assert.equal(made.fields[1]!.references, undefined);
  });

  // Ids are kept; the counter warning appears only when the adapter cannot
  // carry the id sequence forward (the final true or false argument).
  it('a created collection keeps its ids and needs no counter warning when the adapter can move it', () => {
    const target = deriveTarget(
      { from: 'customers', to: 'customers', fields: {} },
      customers,
      new Map([['customers', 'customers']]),
      all,
    );
    const plan = planCollection(
      { from: 'customers', to: 'customers', fields: {} },
      customers,
      target,
      false,
      true,
      all,
      true,
      true,
    );
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.create, true);
    assert.equal(plan.idsPreserved, true);
    assert.ok(plan.fields.some((f) => f.to === 'id'));
    assert.ok(!plan.warnings.some((w) => /counter/.test(w)));
    const without = planCollection(
      { from: 'customers', to: 'customers', fields: {} },
      customers,
      target,
      false,
      true,
      all,
      true,
      false,
    );
    assert.ok(without.warnings.some((w) => /counter/.test(w)));
  });

  // Arrays have a lossless home in json fields, so this must not be flagged as
  // a problem.
  it('arrays can go into json fields', () => {
    const json = defineCollection({
      name: 'o',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tags', type: 'json' },
      ],
    });
    const arr = defineCollection({
      name: 'o',
      fields: [
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'tags', type: 'array' },
      ],
    });
    assert.deepEqual(
      planCollection({ from: 'o', to: 'o', fields: {} }, arr, json, false)
        .problems,
      [],
    );
  });
});
