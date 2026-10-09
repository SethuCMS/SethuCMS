/**
 * Sample content for the built-in "memory" database.
 * It lets you try the whole CMS (browse, edit, draft, publish, preview)
 * without connecting a real database. The data lives in the gateway's memory
 * and is recreated on every restart.
 */
import { defineCollection, type CollectionDefinition } from '@sethucms/core';

/**
 * Schema of the demo database: authors and articles. Exercises the main
 * field types (text, enum, reference, JSON) and validation rules.
 */
export function demoCollections(): CollectionDefinition[] {
  return [
    defineCollection({
      name: 'authors',
      fields: [
        {
          name: 'id',
          type: 'integer',
          primaryKey: true,
          generated: true,
          required: true,
        },
        {
          name: 'name',
          type: 'string',
          required: true,
          validation: { maxLength: 80 },
        },
        { name: 'email', type: 'string' },
        { name: 'bio', type: 'text' },
      ],
      relations: [],
    }),
    defineCollection({
      name: 'articles',
      fields: [
        {
          name: 'id',
          type: 'integer',
          primaryKey: true,
          generated: true,
          required: true,
        },
        {
          name: 'title',
          type: 'string',
          required: true,
          validation: { maxLength: 140 },
        },
        {
          name: 'slug',
          type: 'string',
          required: true,
          validation: { pattern: '^[a-z0-9-]+$' },
        },
        {
          name: 'status',
          type: 'string',
          validation: { enum: ['idea', 'writing', 'review', 'live'] },
        },
        { name: 'featured', type: 'boolean' },
        { name: 'rating', type: 'integer', validation: { min: 0, max: 5 } },
        { name: 'author_id', type: 'reference', references: 'authors' },
        { name: 'body', type: 'text' },
        { name: 'tags', type: 'json' },
      ],
      relations: [],
    }),
  ];
}

/** Sample rows inserted into the demo database on every start. */
export const DEMO_SEED: Record<string, Array<Record<string, unknown>>> = {
  authors: [
    {
      name: 'Asha Verma',
      email: 'asha@example.com',
      bio: 'Writes about databases and the people who run them.',
    },
    {
      name: 'Tomás Ruiz',
      email: 'tomas@example.com',
      bio: 'Editor. Likes short sentences.',
    },
  ],
  articles: [
    {
      title: 'Why every database needs a front door',
      slug: 'front-door',
      status: 'live',
      featured: true,
      rating: 5,
      author_id: 1,
      body: 'Content teams should not need to learn SQL.',
      tags: ['cms', 'databases'],
    },
    {
      title: 'Drafts that never touch production',
      slug: 'safe-drafts',
      status: 'review',
      featured: false,
      rating: 4,
      author_id: 2,
      body: 'Edits stay in the CMS until someone publishes them.',
      tags: ['drafts'],
    },
    {
      title: 'A tour of live preview',
      slug: 'live-preview',
      status: 'writing',
      featured: false,
      rating: 3,
      author_id: 1,
      body: 'Change a word and watch the page update.',
      tags: ['preview'],
    },
  ],
};
