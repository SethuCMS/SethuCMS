/**
 * Browser origins allowed to call the gateway (CORS), managed from the admin.
 *
 *   GET    /v1/admin/origins       (admin) list them, with the fixed ones from the environment,
 *                                  the sites that were recently refused, and when each was last used
 *   POST   /v1/admin/origins       (admin) { origin } allow a site
 *   DELETE /v1/admin/origins/:id   (admin) stop allowing it
 *
 * The SETHUCMS_ALLOWED_ORIGINS list still works and cannot be removed here.
 * Requests carry bearer tokens in a header, never cookies, so CORS never needs
 * credentials. Only exact origins are accepted (scheme, host and optional
 * port, no path), unless the gateway owner switches on one-label wildcards
 * with SETHUCMS_ALLOW_WILDCARD_ORIGINS. The rules are in security/origins.ts.
 */
import { randomUUID } from 'node:crypto';
import { errors, isPlainObject } from '@sethucms/core';
import { requireRole } from '../auth.js';
import { OriginWatch, parseOriginPattern } from '../security/origins.js';
import type { StoredOrigin } from '../store/state.js';
import type { Services } from './services.js';

const MAX_ORIGINS = 100;

/** The normalised exact origin, or throws when the text is not a plain origin. */
export function parseOrigin(text: string): string {
  return parseOriginPattern(text, false).origin;
}

export interface OriginRouteOptions {
  /** Remembers refused sites and last use. Without it those fields stay empty. */
  watch?: OriginWatch;
  /** True when the gateway owner allows `https://*.example.com` entries. */
  allowWildcards?: boolean;
}

export function registerOriginRoutes(
  s: Services,
  fixed: string[],
  /** A workspace owner sees only the origins they added, not the server's own. */
  ownOnly = false,
  options: OriginRouteOptions = {},
): void {
  const watch = options.watch;
  const allowWildcards = options.allowWildcards === true;

  const view = (item: StoredOrigin) => ({
    id: item.id,
    origin: item.origin,
    source: 'admin' as const,
    createdAt: item.createdAt,
    lastSeenAt: watch?.lastUsed(item.origin) ?? null,
  });

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
            ...(ownOnly ? [] : fixed).map((origin) => ({
              id: null,
              origin,
              source: 'environment' as const,
              createdAt: null,
              lastSeenAt: watch?.lastUsed(origin) ?? null,
            })),
            ...added.map(view),
          ],
          // Sites that called this gateway from a browser and were refused.
          blocked: watch?.blocked() ?? [],
          wildcardsEnabled: allowWildcards,
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
      const parsed = parseOriginPattern(input['origin'], allowWildcards);
      const origin = parsed.origin;
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
      // The site is allowed now, so stop listing it as refused.
      watch?.clearAllowedBy(origin);
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'origin.create',
        target: `origin:${item.id}`,
        requestId: ctx.requestId,
        detail: { origin, wildcard: parsed.wildcard },
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
