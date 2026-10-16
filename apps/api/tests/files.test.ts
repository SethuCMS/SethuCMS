// Images and PDFs stored in the connected database: upload, public download,
// delete. A small in-memory adapter that can store files stands in for Firestore
// so the whole gateway path is exercised: roles, read-only mode, type checks,
// SVG safety, caching headers, audit trail and probing.

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

// A real 1x1 picture: uploads are parsed and cleaned, so a made-up header no longer passes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(500)]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');

describe('files stored in the database', () => {
  let t: TestGateway;
  let id: string;
  let readOnlyId: string;
  let plainId: string;
  let editor: string;
  let viewer: string;
  let adapter: FileAdapter;

  before(async () => {
    adapter = new FileAdapter({ collections: [] } as never);
    const withFiles: AdapterKind = {
      label: 'Files (test)',
      create: () => adapter,
      networkHost: () => null,
      files: true,
    };
    const plain: AdapterKind = {
      label: 'No files (test)',
      create: () => new MemoryAdapter({ collections: [] } as never),
      networkHost: () => null,
    };
    t = await startGateway({ seedDemo: false }, { adapters: { withfiles: withFiles, plain } });
    const make = async (kind: string, mode: string) => {
      const r = await t.call('POST', '/v1/admin/connections', {
        body: { name: `${kind} ${mode}`, adapter: kind, mode, config: {} },
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body.data.id as string;
    };
    id = await make('withfiles', 'read_write');
    readOnlyId = await make('withfiles', 'read_only');
    plainId = await make('plain', 'read_write');
    editor = await tokenFor(t, 'editor');
    viewer = await tokenFor(t, 'viewer');
  });
  after(async () => {
    await t.close();
  });

  const upload = (
    connection: string,
    body: Buffer | string,
    type: string | null,
    token: string | null | undefined = undefined,
    name = 'photo.png',
  ) =>
    fetch(`${t.url}/v1/connections/${connection}/files`, {
      method: 'POST',
      headers: {
        ...(type ? { 'Content-Type': type } : {}),
        'X-File-Name': encodeURIComponent(name),
        ...(token === null ? {} : { Authorization: `Bearer ${token ?? editor}` }),
      },
      body,
    }).then(async (r) => ({
      status: r.status,
      body: (await r.json().catch(() => undefined)) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    }));

  it('tells the admin which connections can take uploads', () => {
    const { registry } = t.gateway.services;
    assert.equal(registry.canStoreFiles(registry.require(id)), true);
    assert.equal(registry.canStoreFiles(registry.require(readOnlyId)), false);
    assert.equal(registry.canStoreFiles(registry.require(plainId)), false);
  });

  it('an editor uploads an image and gets a link back; the audit trail records it', async () => {
    const r = await upload(id, PNG, 'image/png');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const file = r.body.data;
    assert.equal(file.size, PNG.length);
    assert.equal(file.contentType, 'image/png');
    assert.equal(file.name, 'photo.png');
    assert.equal(file.path, `/v1/files/${id}/${file.id}`);
    const audit = await t.call('GET', '/v1/admin/audit');
    assert.ok(JSON.stringify(audit.body).includes('file.upload'));
  });

  it('anyone with the link can read it, with safe and cache-friendly headers, and no token', async () => {
    const r = await upload(id, PDF, 'application/pdf', undefined, 'résumé 2026.pdf');
    const url = `${t.url}${r.body.data.path}`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.match(res.headers.get('cache-control')!, /immutable/);
    assert.match(res.headers.get('content-disposition')!, /^inline; filename="r_sum_ 2026\.pdf"; filename\*=UTF-8''r%C3%A9sum%C3%A9%202026\.pdf$/);
    assert.ok(Buffer.compare(Buffer.from(await res.arrayBuffer()), PDF) === 0);
    // A PDF is not given a restrictive policy (Chrome's PDF viewer needs that).
    assert.equal(res.headers.get('content-security-policy'), null);

    const download = await fetch(`${url}?download=1`);
    assert.match(download.headers.get('content-disposition')!, /^attachment;/);
    await download.arrayBuffer();
  });

  it('answers 304 when the browser already has it, and HEAD without a body', async () => {
    const r = await upload(id, PNG, 'image/png');
    const url = `${t.url}${r.body.data.path}`;
    const first = await fetch(url);
    const etag = first.headers.get('etag')!;
    await first.arrayBuffer();
    const again = await fetch(url, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(PNG.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  it('serves an SVG under a policy that runs nothing', async () => {
    const r = await upload(id, SVG, 'image/svg+xml', undefined, 'logo.svg');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const res = await fetch(`${t.url}${r.body.data.path}`);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.match(res.headers.get('content-security-policy')!, /sandbox/);
    await res.arrayBuffer();
  });

  it('refuses scripts inside an SVG', async () => {
    for (const bad of [
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>',
    ]) {
      const r = await upload(id, bad, 'image/svg+xml');
      assert.equal(r.status, 400, bad);
    }
  });

  it('refuses a file whose bytes are not the type it claims, and types that are not allowed', async () => {
    assert.equal((await upload(id, '<html><script>alert(1)</script></html>', 'image/png')).status, 400);
    assert.equal((await upload(id, PNG, 'application/pdf')).status, 400);
    assert.equal((await upload(id, '<html></html>', 'text/html')).status, 400);
    assert.equal((await upload(id, PNG, 'application/octet-stream')).status, 400);
    assert.equal((await upload(id, PNG, null)).status, 400);
  });

  it('refuses empty and oversized files', async () => {
    assert.equal((await upload(id, '', 'image/png')).status, 400);
    const huge = Buffer.concat([PNG, Buffer.alloc(4_000_001)]);
    const r = await upload(id, huge, 'image/png');
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /too large/);
  });

  it('needs a token with the right role to upload', async () => {
    assert.equal((await upload(id, PNG, 'image/png', null)).status, 401);
    assert.equal((await upload(id, PNG, 'image/png', viewer)).status, 403);
    assert.equal((await upload(id, PNG, 'image/png', 'adb_not-a-real-token-0000000000000000')).status, 401);
  });

  it('refuses uploads on a read-only connection and on a database that cannot store files', async () => {
    assert.equal((await upload(readOnlyId, PNG, 'image/png')).status, 403);
    const r = await upload(plainId, PNG, 'image/png');
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'CAPABILITY_UNSUPPORTED');
    assert.equal((await upload('conn_nonexistent', PNG, 'image/png')).status, 404);
  });

  it('answers the same 404 for a missing file, a bad id, a plain database and an unknown connection', async () => {
    const seen = new Set<string>();
    for (const path of [
      `/v1/files/${id}/${'A'.repeat(22)}`,
      `/v1/files/${id}/short`,
      `/v1/files/${id}/..%2F..%2Fx`,
      `/v1/files/${plainId}/${'A'.repeat(22)}`,
      `/v1/files/conn_nonexistent/${'A'.repeat(22)}`,
    ]) {
      const res = await fetch(`${t.url}${path}`);
      assert.equal(res.status, 404, path);
      const body = (await res.json()) as { error: { message: string; code: string } };
      seen.add(`${body.error.code}|${body.error.message}`);
    }
    assert.equal(seen.size, 1, 'nothing is revealed by probing');
  });

  it('only an admin can delete; after that the link stops working', async () => {
    const r = await upload(id, PNG, 'image/png');
    const file = r.body.data;
    const del = (token: string | null | undefined) =>
      t.call('DELETE', `/v1/connections/${id}/files/${file.id}`, { token });
    assert.equal((await del(editor)).status, 403);
    assert.equal((await del(null)).status, 401);
    assert.equal((await del(undefined)).status, 204);
    assert.equal((await fetch(`${t.url}${file.path}`)).status, 404);
    assert.equal((await del(undefined)).status, 404);
    const audit = await t.call('GET', '/v1/admin/audit');
    assert.ok(JSON.stringify(audit.body).includes('file.delete'));
  });

  it('allows the browser header an upload from the admin needs (CORS)', async () => {
    const res = await fetch(`${t.url}/v1/connections/${id}/files`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://admin.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,x-file-name',
      },
    });
    assert.match(res.headers.get('access-control-allow-headers')!, /X-File-Name/i);
  });
});
