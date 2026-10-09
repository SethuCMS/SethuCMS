// Shared users collection and model used by the core tests.

import { defineCollection, ContentModel } from '../src/index.js';

export const users = defineCollection({
  name: 'users',
  fields: [
    { name: 'id', type: 'integer', primaryKey: true, generated: true },
    {
      name: 'email',
      type: 'string',
      required: true,
      validation: { maxLength: 100, pattern: '^[^@]+@[^@]+$' },
    },
    { name: 'age', type: 'integer', validation: { min: 0, max: 150 } },
    { name: 'salary', type: 'decimal' },
    { name: 'tags', type: 'array' },
    { name: 'tenant', type: 'string' },
    { name: 'createdAt', type: 'datetime', readOnly: true },
  ],
  relations: [],
});
export const model = new ContentModel([users]);
