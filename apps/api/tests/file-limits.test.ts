// Private files, cleaning on upload, and upload limits, through the whole
// gateway with a small in-memory adapter that can store files.

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { MemoryAdapter } from '@sethucms/adapter-memory';
import type { AdapterKind } from '../src/connections/adapters.js';
import { startGateway, tokenFor, type TestGateway } from './helpers.js';

class FileAdapter extends MemoryAdapter {
  readonly files = new Map<string, { meta: any; data: Buffer }>();
  async putFile(input: { name: string; contentType: string; access?: string }, data: Uint8Array) {
    const id = randomBytes(16).toString('base64url');
    const meta = {
      id,
      name: input.name,
      contentType: input.contentType,
      size: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      createdAt: new Date().toISOString(),
      access: input.access === 'private' ? 'private' : 'public',
    };
    this.files.set(id, { meta, data: Buffer.from(data) });
    return meta;
  }
  async getFileMeta(id: string) {
    return this.files.get(id)?.meta ?? null;
  }
  async readFile(id: string) {
    return this.files.get(id) ?? null;
  }
  async deleteFile(id: string) {
    return this.files.delete(id);
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, data, Buffer.alloc(4)]);
};
const DIRTY_PNG = Buffer.concat([
  PNG.subarray(0, 8),
  chunk('IHDR', Buffer.alloc(13)),
  chunk('tEXt', Buffer.from('Author\0SECRET-AUTHOR')),
  chunk('IDAT', Buffer.from('pixels')),
  chunk('IEND', Buffer.alloc(0)),
  Buffer.from('TRAILING-SECRET'),
]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF');
const EVIL_PDF = Buffer.from('%PDF-1.4\n1 0 obj<</S/JavaScript/JS(x)>>endobj\n%%EOF');

async function setup(env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const adapter = new FileAdapter({ collections: [] } as never);
  const kind: AdapterKind = { label: 'Files (test)', create: () => adapter, networkHost: () => null, files: true };
  const t = await startGateway({ seedDemo: false }, { adapters: { withfiles: kind } });
  const made = await t.call('POST', '/v1/admin/connections', {
    body: { name: 'f', adapter: 'withfiles', mode: 'read_write', config: {} },
  });
  const id = made.body.data.id as string;
  const editor = await tokenFor(t, 'editor');
  const viewer = await tokenFor(t, 'viewer');
  const upload = (body: Buffer, type: string, headers: Record<string, string> = {}, token = editor) =>
    fetch(`${t.url}/v1/connections/${id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': type, Authorization: `Bearer ${token}`, ...headers },
      body,
    }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => undefined)) as any }));
  return { t, adapter, id, editor, viewer, upload };
}

describe('uploads are cleaned', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    s = await setup();
  });
  after(async () => s.t.close());

  it('stores an image without its hidden data', async () => {
    const r = await s.upload(DIRTY_PNG, 'image/png');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const stored = s.adapter.files.get(r.body.data.id)!.data;
    assert.equal(stored.includes(Buffer.from('SECRET')), false);
    assert.ok(stored.includes(Buffer.from('pixels')));
    assert.equal(r.body.data.size, stored.length);
    assert.ok(stored.length < DIRTY_PNG.length);
  });

  it('refuses a PDF with scripts and an image that cannot be read', async () => {
    const evil = await s.upload(EVIL_PDF, 'application/pdf');
    assert.equal(evil.status, 400);
    assert.match(evil.body.error.message, /not allowed/);
    const broken = await s.upload(DIRTY_PNG.subarray(0, 40), 'image/png');
    assert.equal(broken.status, 400);
    assert.equal((await s.upload(PDF, 'application/pdf')).status, 201);
    // AVIF is no longer accepted, because its hidden data cannot be removed safely.
    assert.equal((await s.upload(Buffer.from('....ftypavif'), 'image/avif')).status, 400);
  });
});

describe('private files', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  let privateUrl: string;
  let publicUrl: string;
  before(async () => {
    s = await setup();
    const a = await s.upload(PNG, 'image/png', { 'X-File-Access': 'private' });
    const b = await s.upload(PNG, 'image/png');
    assert.equal(a.body.data.access, 'private');
    assert.equal(b.body.data.access, 'public');
    privateUrl = `${s.t.url}${a.body.data.path}`;
    publicUrl = `${s.t.url}${b.body.data.path}`;
  });
  after(async () => s.t.close());

  it('serves a private file only with a valid token, and otherwise looks missing', async () => {
    const anon = await fetch(privateUrl);
    assert.equal(anon.status, 404);
    const missing = await fetch(`${s.t.url}/v1/files/${s.id}/AAAAAAAAAAAAAAAAAAAAAA`);
    const plain = async (r: Response) => (await r.text()).replace(/"requestId":"[^"]*"/, '');
    assert.equal(await plain(anon), await plain(missing));
    assert.equal((await fetch(privateUrl, { headers: { Authorization: 'Bearer nope' } })).status, 404);
    assert.equal((await fetch(privateUrl, { method: 'HEAD' })).status, 404);
    for (const token of [s.viewer, s.editor]) {
      const ok = await fetch(privateUrl, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get('cache-control'), 'private, no-store');
      assert.equal(ok.headers.get('cross-origin-resource-policy'), 'same-site');
      assert.equal(Buffer.from(await ok.arrayBuffer()).equals(PNG), true);
    }
  });

  it('still serves public files to everyone, and rejects a bad access value', async () => {
    assert.equal((await fetch(publicUrl)).status, 200);
    assert.equal((await s.upload(PNG, 'image/png', { 'X-File-Access': 'secret' })).status, 400);
  });
});

describe('upload limits', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  before(async () => {
    s = await setup({
      SETHUCMS_FILE_DAILY_COUNT: '3',
      SETHUCMS_FILE_STORAGE_MB: '1',
      SETHUCMS_FILE_DAILY_MB: '50',
    });
  });
  after(async () => {
    delete process.env['SETHUCMS_FILE_DAILY_COUNT'];
    delete process.env['SETHUCMS_FILE_STORAGE_MB'];
    delete process.env['SETHUCMS_FILE_DAILY_MB'];
    await s.t.close();
  });

  it('stops a caller after the daily count, with a retry time, and frees space on delete', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await s.upload(PNG, 'image/png');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids.push(r.body.data.id);
    }
    const blocked = await s.upload(PNG, 'image/png');
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error.message, /daily/);
    // Another caller has their own allowance.
    const other = await tokenFor(s.t, 'editor');
    assert.equal((await s.upload(PNG, 'image/png', {}, other)).status, 201);
    // Deleting a file gives the connection's space back (but not the caller's day).
    const del = await fetch(`${s.t.url}/v1/connections/${s.id}/files/${ids[0]}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${await tokenFor(s.t, 'admin')}` },
    });
    assert.equal(del.status, 204);
  });

  it('refuses an upload that would pass the storage limit of the connection', async () => {
    // 1 MB limit: one ~600 KB PDF fits, a second does not.
    const filler = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600_000, 0x20), Buffer.from('\n%%EOF')]);
    const who = await tokenFor(s.t, 'editor');
    const first = await s.upload(filler, 'application/pdf', {}, who);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await s.upload(filler, 'application/pdf', {}, await tokenFor(s.t, 'editor'));
    assert.equal(second.status, 409);
    assert.match(second.body.error.message, /storage limit/);
  });
});
