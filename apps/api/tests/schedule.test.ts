/** Scheduled publish: set, change, cancel, run when due, fail safely. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseScheduleTime } from '../src/content/drafts.js';
import { demoConnection, startGateway, tokenFor, type TestGateway } from './helpers.js';

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

async function newDraft(t: TestGateway, id: string, recordId: number, values: object) {
  const made = await t.call('POST', `/v1/connections/${id}/collections/articles/drafts`, {
    body: { recordId, values },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.data.id as string;
}

describe('scheduled publish: the time', () => {
  const now = Date.parse('2026-11-05T10:00:00Z');
  it('normalises to UTC and insists on a time zone', () => {
    assert.equal(parseScheduleTime('2026-12-01T09:00:00+05:30', now), '2026-12-01T03:30:00.000Z');
    assert.equal(parseScheduleTime('2026-12-01T09:00Z', now), '2026-12-01T09:00:00.000Z');
    assert.throws(() => parseScheduleTime('2026-12-01T09:00:00', now), /time zone/);
    assert.throws(() => parseScheduleTime('tomorrow', now), /time zone/);
    assert.throws(() => parseScheduleTime(12345, now), /time zone/);
    assert.throws(() => parseScheduleTime('2026-02-31T09:00:00Z', now), /real date|future/);
  });
  it('refuses the past and more than a year ahead', () => {
    assert.throws(() => parseScheduleTime('2026-11-05T09:59:00Z', now), /future/);
    assert.throws(() => parseScheduleTime('2028-01-01T00:00:00Z', now), /at most/);
  });
});

describe('scheduled publish: in the gateway', () => {
  it('schedules, shows the time, changes it, and cancels', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const draftId = await newDraft(t, id, 3, { title: 'Later' });
      const path = `/v1/connections/${id}/collections/articles/drafts/${draftId}/schedule`;

      const when = hours(2);
      const set = await t.call('PUT', path, { body: { publishAt: when } });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.equal(set.body.data.publishAt, when);
      assert.equal(set.body.data.status, 'draft');

      const again = await t.call('PUT', path, { body: { publishAt: hours(5) } });
      assert.notEqual(again.body.data.publishAt, when);

      const cancelled = await t.call('DELETE', path);
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.data.publishAt, undefined);

      assert.equal((await t.call('PUT', path, { body: { publishAt: 'soon' } })).status, 400);
      assert.equal((await t.call('PUT', path, { body: { publishAt: hours(1), extra: 1 } })).status, 400);
      assert.equal((await t.call('PUT', path, { body: { publishAt: hours(1) }, token: null })).status, 401);
    } finally {
      await t.close();
    }
  });

  it('publishes when due, not before, and only once', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/articles`;
      const draftId = await newDraft(t, id, 3, { title: 'Scheduled title' });
      await t.call('PUT', `${base}/drafts/${draftId}/schedule`, { body: { publishAt: hours(1) } });

      const drafts = t.gateway.services.drafts;
      assert.equal(await drafts.runDue(Date.now()), 0, 'not due yet');
      assert.notEqual((await t.call('GET', `${base}/records/3`)).body.data.title, 'Scheduled title');

      assert.equal(await drafts.runDue(Date.now() + 2 * 3_600_000), 1);
      assert.equal((await t.call('GET', `${base}/records/3`)).body.data.title, 'Scheduled title');
      const after = await t.call('GET', `${base}/drafts/${draftId}`);
      assert.equal(after.body.data.status, 'published');

      assert.equal(await drafts.runDue(Date.now() + 3 * 3_600_000), 0, 'never twice');

      const audit = await t.call('GET', '/v1/admin/audit?limit=50');
      const ops = JSON.stringify(audit.body);
      assert.match(ops, /draft\.schedule/);
      assert.match(ops, /record\.publish/);
    } finally {
      await t.close();
    }
  });

  it('keeps the latest edits: a draft changed after scheduling publishes the change', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/articles`;
      const draftId = await newDraft(t, id, 3, { title: 'First' });
      await t.call('PUT', `${base}/drafts/${draftId}/schedule`, { body: { publishAt: hours(1) } });
      const saved = await t.call('PATCH', `${base}/drafts/${draftId}`, { body: { version: 1, values: { title: 'Second' } } });
      assert.equal(saved.status, 200);
      assert.ok(saved.body.data.publishAt, 'schedule survives an edit');
      await t.gateway.services.drafts.runDue(Date.now() + 2 * 3_600_000);
      assert.equal((await t.call('GET', `${base}/records/3`)).body.data.title, 'Second');
    } finally {
      await t.close();
    }
  });

  it('on failure clears the schedule, says why, and does not retry', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/articles`;
      const draftId = await newDraft(t, id, 3, { title: 'Will clash' });
      await t.call('PUT', `${base}/drafts/${draftId}/schedule`, { body: { publishAt: hours(1) } });
      // Someone edits the live record meanwhile: publish refuses without force.
      await t.call('PATCH', `${base}/records/3`, { body: { body: 'Changed behind the draft' } });

      const drafts = t.gateway.services.drafts;
      assert.equal(await drafts.runDue(Date.now() + 2 * 3_600_000), 0);
      const draft = (await t.call('GET', `${base}/drafts/${draftId}`)).body.data;
      assert.equal(draft.status, 'draft');
      assert.equal(draft.publishAt, undefined);
      assert.match(draft.scheduleError, /changed/);
      assert.notEqual((await t.call('GET', `${base}/records/3`)).body.data.title, 'Will clash');

      assert.equal(await drafts.runDue(Date.now() + 9 * 3_600_000), 0, 'no retry loop');
    } finally {
      await t.close();
    }
  });

  it('fails when the person who scheduled it has lost access', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/articles`;
      const editor = await tokenFor(t, 'editor');
      const made = await t.call('POST', `${base}/drafts`, { token: editor, body: { recordId: 2, values: { title: 'By editor' } } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const draftId = made.body.data.id as string;
      const set = await t.call('PUT', `${base}/drafts/${draftId}/schedule`, { token: editor, body: { publishAt: hours(1) } });
      assert.equal(set.status, 200, JSON.stringify(set.body));

      const list = await t.call('GET', '/v1/admin/tokens');
      const mine = (list.body.data as Array<{ id: string; name: string }>).find((item) => item.name === 'editor test');
      assert.ok(mine);
      assert.equal((await t.call('DELETE', `/v1/admin/tokens/${mine.id}`)).status, 204);

      assert.equal(await t.gateway.services.drafts.runDue(Date.now() + 2 * 3_600_000), 0);
      const draft = (await t.call('GET', `${base}/drafts/${draftId}`)).body.data;
      assert.match(draft.scheduleError, /can no longer publish/);
    } finally {
      await t.close();
    }
  });

  it('refuses a viewer, and refuses on a serverless gateway', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      const base = `/v1/connections/${id}/collections/articles`;
      const draftId = await newDraft(t, id, 3, { title: 'x' });
      const viewer = await tokenFor(t, 'viewer');
      const denied = await t.call('PUT', `${base}/drafts/${draftId}/schedule`, { token: viewer, body: { publishAt: hours(1) } });
      assert.equal(denied.status, 403);
    } finally {
      await t.close();
    }
    const s = await startGateway({ serverless: true } as never);
    try {
      const id = await demoConnection(s);
      const base = `/v1/connections/${id}/collections/articles`;
      const draftId = await newDraft(s, id, 3, { title: 'x' });
      const refused = await s.call('PUT', `${base}/drafts/${draftId}/schedule`, { body: { publishAt: hours(1) } });
      assert.equal(refused.status, 422, JSON.stringify(refused.body));
      assert.match(refused.body.error.message, /serverless/);
    } finally {
      await s.close();
    }
  });
});
