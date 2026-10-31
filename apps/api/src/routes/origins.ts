/**
 * Browser origins allowed to call the gateway (CORS), managed from the admin.
 *
 *   GET    /v1/admin/origins       (admin) list them, with the fixed ones from the environment
 *   POST   /v1/admin/origins       (admin) { origin } allow a site
 *   DELETE /v1/admin/origins/:id   (admin) stop allowing it
 *
 * The SETHUCMS_ALLOWED_ORIGINS list still works and cannot be removed here.
 * Credentials are always sent with bearer tokens, so only exact origins are
 * accepted: scheme, host and optional port, no path and no wildcard.
 */
import { randomUUID } from 'node:crypto';
import { errors, isPlainObject } from '@sethucms/core';
import { requireRole } from '../auth.js';
import type { StoredOrigin } from '../store/state.js';
import type { Services } from './services.js';

const MAX_ORIGINS = 100;

/** The normalised origin, or throws when the text is not a plain origin. */
export function parseOrigin(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw errors.validation('Enter an origin such as https://example.com');
  }
  const plain =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password &&
    !text.includes('*');
  if (!plain) {
    throw errors.validation(
      'Use only the scheme, host and port, for example https://example.com',
    );
  }
  return url.origin;
}

const view = (item: StoredOrigin) => ({
  id: item.id,
  origin: item.origin,
  source: 'admin' as const,
  createdAt: item.createdAt,
});

export function registerOriginRoutes(s: Services, fixed: string[]): void {
  s.router.add({
    method: 'GET',
    pattern: '/v1/admin/origins',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      const added = Object.values(s.store.read().origins ?? {});
      return {
        status: 200,
        body: {
          data: [
            ...fixed.map((origin) => ({ id: null, origin, source: 'environment' as const, createdAt: null })),
            ...added.map(view),
          ],
        },
      };
    },
  });

  s.router.add({
    method: 'POST',
    pattern: '/v1/admin/origins',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input) || typeof input['origin'] !== 'string') {
        throw errors.validation('Body must be { "origin": "https://example.com" }');
      }
      const origin = parseOrigin(input['origin']);
      const item: StoredOrigin = {
        id: `org_${randomUUID().slice(0, 8)}`,
        origin,
        createdAt: new Date().toISOString(),
        createdBy: ctx.principal.id,
      };
      await s.store.update((state) => {
        const all = (state.origins ??= {});
        if (fixed.includes(origin) || Object.values(all).some((o) => o.origin === origin)) {
          throw errors.conflict('That origin is already allowed');
        }
        if (Object.keys(all).length >= MAX_ORIGINS) {
          throw errors.conflict('Too many origins. Remove some first.');
        }
        all[item.id] = item;
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'origin.create',
        target: `origin:${item.id}`,
        requestId: ctx.requestId,
        detail: { origin },
      });
      return { status: 201, body: { data: view(item) } };
    },
  });

  s.router.add({
    method: 'DELETE',
    pattern: '/v1/admin/origins/:originId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['originId'] as string;
      const removed = await s.store.update((state) => {
        const found = state.origins?.[id];
        if (!found) {
          throw errors.notFound('Origin not found');
        }
        delete state.origins![id];
        return found;
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'origin.delete',
        target: `origin:${id}`,
        requestId: ctx.requestId,
        detail: { origin: removed.origin },
      });
      return { status: 204 };
    },
  });
}
