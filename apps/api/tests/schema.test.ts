/** Schema as code: what it changes, what it must never change. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { loadSchema, parseSchema, SchemaError } from '../src/schema/code.js';
import { demoConnection, startGateway, tokenFor } from './helpers.js';

describe('schema file: checking', () => {
  it('refuses typos, bad widgets and duplicates with a clear message', () => {
    assert.throws(() => parseSchema({ collections: [{ name: 'a', feilds: [] }] }), /unknown setting "feilds"/);
    assert.throws(
      () => parseSchema({ collections: [{ name: 'a', fields: [{ name: 'x', widget: 'rainbow' }] }] }),
      /widget must be one of/,
    );
    assert.throws(
      () => parseSchema({ collections: [{ name: 'a' }, { name: 'a' }] }),
      /listed twice/,
    );
    assert.throws(() => parseSchema({ collections: [{ name: '__proto__' }] }), SchemaError);
    assert.throws(
      () => parseSchema({ collections: [{ name: 'a', titleField: 'z', fields: [{ name: 'x' }] }] }),
      /titleField/,
    );
  });

  it('loads a .json and a .mjs file, and refuses a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schema-'));
    await writeFile(join(dir, 's.json'), JSON.stringify({ collections: [{ name: 'a' }] }));
    await writeFile(join(dir, 's.mjs'), "export default { collections: [{ name: 'b' }] };");
    assert.equal((await loadSchema({ SETHUCMS_SCHEMA_FILE: join(dir, 's.json') }))?.collections[0]?.name, 'a');
    assert.equal((await loadSchema({ SETHUCMS_SCHEMA_FILE: join(dir, 's.mjs') }))?.collections[0]?.name, 'b');
    await assert.rejects(loadSchema({ SETHUCMS_SCHEMA_FILE: join(dir, 'nope.json') }), /not found/);
    assert.equal(await loadSchema({}), undefined);
  });
});

describe('schema file: in the gateway', () => {
  const schema = {
    collections: [
      {
        name: 'articles',
        title: 'Posts',
        titleField: 'title',
        fields: [
          { name: 'title', label: 'Headline', maxLength: 10 },
          { name: 'status', readOnly: true },
          { name: 'body', widget: 'code', hidden: true },
          { name: 'ghost' },
        ],
      },
    ],
  };

  it('labels, hides and limits fields, and reports mismatches to admins', async () => {
    const t = await startGateway({}, { schema });
    try {
      const id = await demoConnection(t);
      const detail = await t.call('GET', `/v1/connections/${id}/collections/articles`);
      assert.equal(detail.status, 200);
      const fields = detail.body.data.fields as Array<any>;
      const get = (name: string) => fields.find((field) => field.name === name);
      assert.equal(get('title').ui.label, 'Headline');
      assert.equal(get('title').validation.maxLength, 10);
      assert.equal(get('body').ui.hidden, true);
      assert.equal(get('body').ui.widget, 'code');
      assert.equal(get('status').editable, false);
      assert.deepEqual(detail.body.data.ui, { title: 'Posts', titleField: 'title' });

      const report = await t.call('GET', '/v1/schema');
      assert.equal(report.body.data.configured, true);
      assert.ok(
        report.body.data.checks[0].notes.some((note: string) => note.includes('articles.ghost')),
      );
      const editor = await tokenFor(t, 'editor');
      assert.equal((await t.call('GET', '/v1/schema', { token: editor })).status, 403);
    } finally {
      await t.close();
    }
  });

  it('enforces the limits and read-only rules on writes, not just in the form', async () => {
    const t = await startGateway({}, { schema });
    try {
      const id = await demoConnection(t);
      const path = `/v1/connections/${id}/collections/articles/records`;
      const tooLong = await t.call('POST', path, {
        body: { title: 'a title far longer than ten', slug: 'long' },
      });
      assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
      const fine = await t.call('POST', path, { body: { title: 'Short', slug: 'short' } });
      assert.equal(fine.status, 201, JSON.stringify(fine.body));
      // status is read-only in the schema: a write cannot change it.
      const sneaky = await t.call('POST', path, {
        body: { title: 'Short', slug: 'short-2', status: 'live' },
      });
      assert.ok(sneaky.status >= 400 && sneaky.status < 500, `got ${sneaky.status}`);
    } finally {
      await t.close();
    }
  });

  it('without a schema nothing changes', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const detail = await t.call('GET', `/v1/connections/${id}/collections/articles`);
      assert.equal(detail.body.data.ui, undefined);
      assert.deepEqual((await t.call('GET', '/v1/schema')).body.data, { configured: false });
    } finally {
      await t.close();
    }
  });
});
