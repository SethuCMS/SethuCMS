// Drafts, publishing and signed previews, end to end.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  demoConnection,
  readEvents,
  startGateway,
  type TestGateway,
} from './helpers.js';

describe('drafts, publish and preview', () => {
  let t: TestGateway;
  let id: string;
  before(async () => {
    t = await startGateway();
    id = await demoConnection(t);
  });
  after(async () => {
    await t.close();
  });

  const drafts = () => `/v1/connections/${id}/collections/articles/drafts`;
  const records = () => `/v1/connections/${id}/collections/articles/records`;

  // Edits live in the draft only; the public record must not change before
  // publish.
  it('keeps edits out of the database until published', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 3, values: { title: 'Live preview, v2' } },
    });
    assert.equal(draft.status, 201);
    assert.equal(draft.body.data.version, 1);

    const published = await t.call('GET', `${records()}/3`);
    assert.equal(published.body.data.title, 'A tour of live preview');

    const saved = await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { body: 'Edited body' } },
    });
    assert.equal(saved.body.data.version, 2);
    assert.equal(saved.body.data.values.title, 'Live preview, v2');
    assert.equal(
      (await t.call('GET', `${records()}/3`)).body.data.body,
      'Change a word and watch the page update.',
    );

    const result = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
      { body: { version: 2 } },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.data.record.title, 'Live preview, v2');
    assert.equal(
      (await t.call('GET', `${records()}/3`)).body.data.body,
      'Edited body',
    );
    assert.equal(result.body.data.draft.status, 'published');

    const again = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(again.status, 409);
  });

  // Drafts can be partial; completeness is enforced when publishing, not when
  // saving.
  it('creates new records from drafts and checks completeness only on publish', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { values: { title: 'Half finished' } },
    });
    assert.equal(draft.status, 201);
    const early = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(early.status, 400); // slug is required
    const fixed = await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { slug: 'half-finished' } },
    });
    assert.equal(fixed.status, 200);
    const done = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(done.status, 200);
    assert.ok(done.body.data.record.id);
  });

  // Optimistic locking - a stale save must not overwrite a newer one, and the
  // current version is returned so the client can recover.
  it('refuses a save based on an old version', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { rating: 4 } },
    });
    await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { rating: 3 } },
    });
    const stale = await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
      body: { version: 1, values: { rating: 2 } },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.details.currentVersion, 2);
  });

  // Publishing over a record changed in the meantime would silently lose that
  // edit; the editor must choose via force.
  it('refuses to publish over a record that changed meanwhile, unless forced', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 2, values: { title: 'My edit' } },
    });
    await t.call('PATCH', `${records()}/2`, { body: { rating: 1 } }); // someone else edits the live record
    const blocked = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.details.reason, 'record_changed');
    // The draft is still open so the editor can decide.
    const open = await t.call('GET', `${drafts()}/${draft.body.data.id}`);
    assert.equal(open.body.data.status, 'draft');
    const forced = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/publish`,
      { body: { force: true } },
    );
    assert.equal(forced.status, 200);
    assert.equal(forced.body.data.record.title, 'My edit');
  });

  // Drafts must be held to the same rules as direct writes, or they would be a
  // validation bypass.
  it('validates draft values like record values', async () => {
    assert.equal(
      (await t.call('POST', drafts(), { body: { values: { rating: 99 } } }))
        .status,
      400,
    );
    assert.equal(
      (await t.call('POST', drafts(), { body: { values: { id: 5 } } })).status,
      400,
    );
    assert.equal(
      (await t.call('POST', drafts(), { body: { values: { nope: 1 } } }))
        .status,
      400,
    );
    assert.equal(
      (await t.call('POST', drafts(), { body: { recordId: 9999, values: {} } }))
        .status,
      404,
    );
  });

  // Discarding must leave no trace in the published data.
  it('discarding a draft leaves the record alone', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'Throwaway' } },
    });
    assert.equal(
      (await t.call('DELETE', `${drafts()}/${draft.body.data.id}`)).status,
      204,
    );
    assert.notEqual(
      (await t.call('GET', `${records()}/1`)).body.data.title,
      'Throwaway',
    );
    const open = await t.call('GET', drafts());
    assert.ok(!open.body.data.some((d: any) => d.id === draft.body.data.id));
  });

  // A draft id must only resolve under its own collection, or collection-level
  // permissions could be sidestepped.
  it('drafts cannot be reached through a different collection', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'X' } },
    });
    const wrong = await t.call(
      'GET',
      `/v1/connections/${id}/collections/authors/drafts/${draft.body.data.id}`,
    );
    assert.equal(wrong.status, 404);
  });

  // Preview links are bearer credentials for unpublished content, so they must
  // work without a token yet reject forgeries and be kept out of search
  // indexes.
  it('shows a draft through a preview link without an API token', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'Preview me' } },
    });
    const link = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/preview-link`,
    );
    assert.equal(link.status, 201);

    const view = await t.call('GET', link.body.data.path, { token: null });
    assert.equal(view.status, 200);
    assert.equal(view.body.data.title, 'Preview me');
    assert.equal(view.body.data.slug, 'front-door'); // untouched fields come from the published record
    assert.equal(view.headers.get('x-robots-tag'), 'noindex');

    const forged = link.body.data.token.replace(/.$/, (c: string) =>
      c === 'A' ? 'B' : 'A',
    );
    assert.equal(
      (await t.call('GET', `/v1/preview/${forged}`, { token: null })).status,
      401,
    );
    assert.equal(
      (await t.call('GET', '/v1/preview/garbage', { token: null })).status,
      401,
    );
  });

  // A preview link must not outlive the access of the person who made it.
  it('stops preview links when the person who made them loses access', async () => {
    const created = await t.call('POST', '/v1/admin/tokens', {
      body: { name: 'short-lived', role: 'editor' },
    });
    const draft = await t.call('POST', drafts(), {
      token: created.body.data.token,
      body: { recordId: 1, values: { title: 'Soon gone' } },
    });
    const link = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/preview-link`,
      { token: created.body.data.token },
    );
    assert.equal(
      (await t.call('GET', link.body.data.path, { token: null })).status,
      200,
    );
    await t.call('DELETE', `/v1/admin/tokens/${created.body.data.id}`);
    assert.equal(
      (await t.call('GET', link.body.data.path, { token: null })).status,
      401,
    );
  });

  // Live preview depends on pushing draft changes over SSE; the first event is
  // the current state, then updates.
  it('pushes draft changes to an open preview (live preview)', async () => {
    const draft = await t.call('POST', drafts(), {
      body: { recordId: 1, values: { title: 'First' } },
    });
    const link = await t.call(
      'POST',
      `${drafts()}/${draft.body.data.id}/preview-link`,
    );
    const events = await readEvents(
      t.url + link.body.data.path + '/events',
      {},
      2,
      async () => {
        await t.call('PATCH', `${drafts()}/${draft.body.data.id}`, {
          body: { version: 1, values: { title: 'Second' } },
        });
      },
    );
    assert.equal(events[0]?.event, 'draft');
    assert.equal(events[0]?.data.data.title, 'First');
    assert.equal(events[1]?.event, 'draft.updated');
    assert.equal(events[1]?.data.data.title, 'Second');
  });
});
