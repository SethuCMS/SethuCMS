/**
 * Images and PDFs kept in the connected database.
 *
 *   POST   /v1/connections/:id/files        upload (editor or admin; raw bytes)
 *   GET    /v1/files/:id/:fileId            download (public by link, see below)
 *   HEAD   /v1/files/:id/:fileId            the same headers, no body
 *   DELETE /v1/connections/:id/files/:fileId  remove (admin)
 *
 * Reading a public file needs no token, so a website can show an image with a
 * plain <img>. The link cannot be guessed (128 random bits) but anyone who has
 * it can read the file, like any "anyone with the link" share. A file uploaded
 * with the header "X-File-Access: private" is different: it is only served to
 * a caller who sends a valid token (any role), and looks missing to everyone else.
 *
 * Every upload is cleaned first (see files/clean.ts) and counted against limits:
 * total storage per connection, and uploads per caller per day. Limits can be
 * changed with SETHUCMS_FILE_STORAGE_MB, SETHUCMS_FILE_DAILY_MB and
 * SETHUCMS_FILE_DAILY_COUNT.
 * Only databases whose adapter can store files offer this (Firestore).
 */
import { errors } from '@sethucms/core';
import { requireRole } from '../auth.js';
import {
  FILE_TYPES,
  MAX_FILE_BYTES,
  allowedType,
  checkFile,
  cleanName,
  disposition,
} from '../files/kinds.js';
import { readBytes } from '../http/respond.js';
import type { RequestContext } from '../http/router.js';
import type { Services } from './services.js';

interface FileMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: string;
  access?: 'public' | 'private';
}

/** What an adapter offers when it can store files (see the Firestore adapter). */
interface FileAdapter {
  putFile(
    input: { name: string; contentType: string; access: 'public' | 'private' },
    data: Uint8Array,
  ): Promise<FileMeta>;
  getFileMeta(id: string): Promise<FileMeta | null>;
  readFile(id: string): Promise<{ meta: FileMeta; data: Buffer } | null>;
  deleteFile(id: string): Promise<boolean>;
}

const canStoreFiles = (adapter: unknown): adapter is FileAdapter => {
  const a = adapter as Partial<FileAdapter> | null;
  return (
    !!a &&
    typeof a.putFile === 'function' &&
    typeof a.getFileMeta === 'function' &&
    typeof a.readFile === 'function' &&
    typeof a.deleteFile === 'function'
  );
};

const FILE_ID = /^[A-Za-z0-9_-]{22}$/;

/** A positive whole number from the environment, or the default. */
const fromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function registerFileRoutes(s: Services): void {
  const { router } = s;
  const limits = {
    totalBytes: fromEnv('SETHUCMS_FILE_STORAGE_MB', 100) * 1_000_000,
    dailyBytes: fromEnv('SETHUCMS_FILE_DAILY_MB', 50) * 1_000_000,
    dailyCount: fromEnv('SETHUCMS_FILE_DAILY_COUNT', 100),
  };
  const today = (): string => new Date().toISOString().slice(0, 10);

  /** Count an upload against the limits, or refuse it. Undone by `release`. */
  const reserve = (connectionId: string, caller: string, size: number) =>
    s.store.update((state) => {
      const day = today();
      for (const [key, usage] of Object.entries(state.fileUsage)) {
        if (usage.day && usage.day < day) {
          delete state.fileUsage[key];
        }
      }
      const connectionKey = `c:${connectionId}`;
      const dayKey = `d:${caller}:${day}`;
      const total = (state.fileUsage[connectionKey] ??= { id: connectionKey, bytes: 0, count: 0 });
      const daily = (state.fileUsage[dayKey] ??= { id: dayKey, bytes: 0, count: 0, day });
      if (total.bytes + size > limits.totalBytes) {
        throw errors.conflict(
          `The storage limit for this connection (${limits.totalBytes / 1_000_000} MB) is reached. Delete files you no longer need.`,
        );
      }
      if (daily.count + 1 > limits.dailyCount || daily.bytes + size > limits.dailyBytes) {
        const tomorrow = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
        throw errors.rateLimited('The daily upload limit is reached. Try again tomorrow.', {
          retryAfter: Math.max(1, Math.ceil((tomorrow - Date.now()) / 1000)),
        });
      }
      total.bytes += size;
      total.count += 1;
      daily.bytes += size;
      daily.count += 1;
    });

  /** Give back what `reserve` took (an upload failed) or free space (a file was deleted). */
  const release = (connectionId: string, caller: string | null, size: number) =>
    s.store.update((state) => {
      const total = state.fileUsage[`c:${connectionId}`];
      if (total) {
        total.bytes = Math.max(0, total.bytes - size);
        total.count = Math.max(0, total.count - 1);
      }
      const daily = caller ? state.fileUsage[`d:${caller}:${today()}`] : undefined;
      if (daily) {
        daily.bytes = Math.max(0, daily.bytes - size);
        daily.count = Math.max(0, daily.count - 1);
      }
    });

  const adapterOf = async (connectionId: string): Promise<FileAdapter> => {
    const { adapter } = await s.registry.raw(connectionId);
    if (!canStoreFiles(adapter)) {
      throw errors.unsupported('This database type cannot store files');
    }
    return adapter;
  };
  const writable = (connectionId: string): void => {
    if (s.registry.require(connectionId).mode !== 'read_write') {
      throw errors.readOnly();
    }
  };

  router.add({
    method: 'POST',
    pattern: '/v1/connections/:connectionId/files',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin', 'editor');
      const connectionId = ctx.params['connectionId'] as string;
      writable(connectionId);
      const adapter = await adapterOf(connectionId);
      const type = allowedType(ctx.req.headers['content-type']);
      if (!type) {
        throw errors.validation(
          `Send the file with a Content-Type of one of: ${Object.keys(FILE_TYPES).join(', ')}`,
        );
      }
      const name = cleanName(headerText(ctx.req.headers['x-file-name']));
      const accessHeader = headerText(ctx.req.headers['x-file-access'])?.trim().toLowerCase();
      if (accessHeader !== undefined && accessHeader !== 'public' && accessHeader !== 'private') {
        throw errors.validation('X-File-Access must be "public" or "private"');
      }
      const access = accessHeader === 'private' ? 'private' : 'public';
      const received = await readBytes(ctx.req, MAX_FILE_BYTES);
      // Checked and cleaned: what is stored may be a little smaller than what was sent.
      const bytes = checkFile(type, received);
      await reserve(connectionId, ctx.principal.id, bytes.length);
      let meta: FileMeta;
      try {
        meta = await adapter.putFile({ name, contentType: type, access }, bytes);
      } catch (error) {
        await release(connectionId, ctx.principal.id, bytes.length).catch(() => undefined);
        throw error;
      }
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'file.upload',
        target: `${connectionId}/${meta.id}`,
        detail: { name: meta.name, contentType: meta.contentType, size: meta.size, access },
      });
      return {
        status: 201,
        body: { data: { ...meta, path: `/v1/files/${connectionId}/${meta.id}` } },
      };
    },
  });

  router.add({
    method: 'DELETE',
    pattern: '/v1/connections/:connectionId/files/:fileId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const connectionId = ctx.params['connectionId'] as string;
      const fileId = ctx.params['fileId'] as string;
      writable(connectionId);
      const adapter = await adapterOf(connectionId);
      const existing = FILE_ID.test(fileId) ? await adapter.getFileMeta(fileId) : null;
      if (!existing || !(await adapter.deleteFile(fileId))) {
        throw errors.notFound('File not found');
      }
      await release(connectionId, null, existing.size);
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'file.delete',
        target: `${connectionId}/${fileId}`,
      });
      return { status: 204 };
    },
  });

  // Public reads. A missing connection, a database without file storage and a
  // missing file all answer the same 404, so nothing is revealed by probing.
  const serve = (head: boolean) => async (ctx: RequestContext) => {
    const connectionId = ctx.params['connectionId'] as string;
    const fileId = ctx.params['fileId'] as string;
    let adapter: FileAdapter;
    try {
      adapter = await adapterOf(connectionId);
    } catch {
      throw errors.notFound('File not found');
    }
    const meta = FILE_ID.test(fileId) ? await adapter.getFileMeta(fileId) : null;
    if (!meta) {
      throw errors.notFound('File not found');
    }
    const isPrivate = meta.access === 'private';
    if (isPrivate) {
      // Same answer as a missing file, so a private file's existence is not revealed.
      try {
        s.auth.authenticate(ctx.req.headers['authorization']);
      } catch {
        throw errors.notFound('File not found');
      }
    }
    const etag = `"${meta.sha256}"`;
    const headers: Record<string, string | number> = {
      'Content-Type': meta.contentType,
      'Content-Disposition': disposition(
        meta.name,
        ctx.url.searchParams.get('download') === '1',
      ),
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // The id never points at different bytes, so browsers and CDNs may keep a
      // public file. A private one is never kept by shared caches.
      'Cache-Control': isPrivate ? 'private, no-store' : 'public, max-age=31536000, immutable',
      // Websites on other domains must be able to show a public file.
      'Cross-Origin-Resource-Policy': isPrivate ? 'same-site' : 'cross-origin',
      ETag: etag,
    };
    // An SVG opened on its own must not run anything. (Not set for PDFs: Chrome's
    // PDF viewer does not work under a restrictive policy, and a PDF runs no page script.)
    if (meta.contentType === 'image/svg+xml') {
      headers['Content-Security-Policy'] =
        "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return 'handled' as const;
    }
    if (head) {
      ctx.res.writeHead(200, { ...headers, 'Content-Length': meta.size });
      ctx.res.end();
      return 'handled' as const;
    }
    const found = await adapter.readFile(fileId);
    if (!found) {
      throw errors.notFound('File not found');
    }
    ctx.res.writeHead(200, { ...headers, 'Content-Length': found.data.length });
    ctx.res.end(found.data);
    return 'handled' as const;
  };
  router.add({
    method: 'GET',
    pattern: '/v1/files/:connectionId/:fileId',
    auth: 'none',
    handler: serve(false),
  });
  router.add({
    method: 'HEAD',
    pattern: '/v1/files/:connectionId/:fileId',
    auth: 'none',
    handler: serve(true),
  });
}

const headerText = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;
