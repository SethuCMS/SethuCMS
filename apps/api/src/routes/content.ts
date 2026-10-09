/**
 * Routes for content: connections and collections as editors see them,
 * records, drafts, preview and live events.
 */
import {
  errors,
  isPlainObject,
  type CollectionDefinition,
} from '@sethucms/core';
import { accessFor, tryReadAccess } from '../content/access.js';
import { openEventStream } from '../http/sse.js';
import type { Bound } from '../connections/registry.js';
import type { Services } from './services.js';
import { capabilitySummary } from './views.js';

// Parse the JSON body and insist it is an object (not an array or scalar),
// so handlers can index into it safely.
const body = async (ctx: {
  json(): Promise<unknown>;
}): Promise<Record<string, unknown>> => {
  const value = await ctx.json();
  if (!isPlainObject(value)) {
    throw errors.validation('Body must be a JSON object');
  }
  return value;
};

/**
 * Register the content API: connections, collections, records, drafts,
 * signed preview links and live event streams.
 *
 * Handlers stay thin. Role checks, field-level access and validation all
 * live in the records/drafts services, so every path is checked the same.
 *
 * @param s Shared services.
 */
export function registerContentRoutes(s: Services): void {
  const { router } = s;

  // ---- Connections and collections (SDK contract) ---------------------

  router.add({
    method: 'GET',
    pattern: '/v1/connections',
    auth: 'token',
    handler: () => ({
      status: 200,
      body: {
        data: s.registry.list().map((connection) => ({
          id: connection.id,
          name: connection.name,
          adapterType: connection.adapterType,
          mode: connection.mode,
          status: s.registry.healthOf(connection.id).status,
        })),
      },
    }),
  });

  // Lists only collections the caller may read; others are not revealed.
  router.add({
    method: 'GET',
    pattern: '/v1/connections/:connectionId/collections',
    auth: 'token',
    handler: async (ctx) => {
      const bound = await s.registry.bind(ctx.params['connectionId'] as string);
      const visible = bound.model
        .list()
        .filter((collection) => tryReadAccess(ctx.principal, collection));
      return {
        status: 200,
        body: {
          data: visible.map((collection) => ({
            name: collection.name,
            displayName: collection.name,
            fields: collection.fields.map((field) => ({
              name: field.name,
              type: field.type,
              required: field.required === true,
              primaryKey: field.primaryKey === true,
            })),
          })),
        },
      };
    },
  });

  router.add({
    method: 'GET',
    pattern: '/v1/connections/:connectionId/collections/:collection',
    auth: 'token',
    handler: async (ctx) => {
      const bound = await s.registry.bind(ctx.params['connectionId'] as string);
      const collection = bound.model.require(
        ctx.params['collection'] as string,
      );
      return {
        status: 200,
        body: { data: describeCollection(ctx.principal, bound, collection) },
      };
    },
  });

  // ---- Records --------------------------------------------------------

  // Record paths hang off one collection; reused for each verb below.
  const base = '/v1/connections/:connectionId/collections/:collection/records';

  router.add({
    method: 'GET',
    pattern: base,
    auth: 'token',
    handler: async (ctx) => ({
      status: 200,
      body: await s.records.list(
        ctx.principal,
        ctx.params['connectionId'] as string,
        ctx.params['collection'] as string,
        ctx.url.searchParams,
      ),
    }),
  });

  router.add({
    method: 'GET',
    pattern: `${base}/:id`,
    auth: 'token',
    handler: async (ctx) => ({
      status: 200,
      body: {
        data: await s.records.get(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          ctx.params['id'] as string,
        ),
      },
    }),
  });

  router.add({
    method: 'POST',
    pattern: base,
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => ({
      status: 201,
      body: {
        data: await s.records.create(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          await ctx.json(),
          ctx.requestId,
        ),
      },
    }),
  });

  // `idempotent`: a retried write with the same Idempotency-Key is not
  // applied twice.
  router.add({
    method: 'PATCH',
    pattern: `${base}/:id`,
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => ({
      status: 200,
      body: {
        data: await s.records.update(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          ctx.params['id'] as string,
          await ctx.json(),
          ctx.requestId,
        ),
      },
    }),
  });

  router.add({
    method: 'DELETE',
    pattern: `${base}/:id`,
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => {
      await s.records.delete(
        ctx.principal,
        ctx.params['connectionId'] as string,
        ctx.params['collection'] as string,
        ctx.params['id'] as string,
        ctx.requestId,
      );
      return { status: 204 };
    },
  });

  // ---- Drafts ---------------------------------------------------------

  const drafts = '/v1/connections/:connectionId/collections/:collection/drafts';

  router.add({
    method: 'GET',
    pattern: drafts,
    auth: 'token',
    handler: async (ctx) => ({
      status: 200,
      body: {
        data: await s.drafts.list(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          ctx.url.searchParams.get('status'),
        ),
      },
    }),
  });

  router.add({
    method: 'POST',
    pattern: drafts,
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => ({
      status: 201,
      body: {
        data: await s.drafts.create(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          await ctx.json(),
          ctx.requestId,
        ),
      },
    }),
  });

  router.add({
    method: 'GET',
    pattern: `${drafts}/:draftId`,
    auth: 'token',
    handler: async (ctx) => ({
      status: 200,
      body: {
        data: await s.drafts.get(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          ctx.params['draftId'] as string,
        ),
      },
    }),
  });

  router.add({
    method: 'PATCH',
    pattern: `${drafts}/:draftId`,
    auth: 'token',
    handler: async (ctx) => ({
      status: 200,
      body: {
        data: await s.drafts.save(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          ctx.params['draftId'] as string,
          await ctx.json(),
          ctx.requestId,
        ),
      },
    }),
  });

  router.add({
    method: 'DELETE',
    pattern: `${drafts}/:draftId`,
    auth: 'token',
    handler: async (ctx) => {
      await s.drafts.discard(
        ctx.principal,
        ctx.params['connectionId'] as string,
        ctx.params['collection'] as string,
        ctx.params['draftId'] as string,
        ctx.requestId,
      );
      return { status: 204 };
    },
  });

  // Publish may be called with no body at all; skip parsing in that case.
  router.add({
    method: 'POST',
    pattern: `${drafts}/:draftId/publish`,
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => {
      const input =
        ctx.req.headers['content-length'] === '0' ||
        ctx.req.headers['content-length'] === undefined
          ? {}
          : await ctx.json();
      return {
        status: 200,
        body: {
          data: await s.drafts.publish(
            ctx.principal,
            ctx.params['connectionId'] as string,
            ctx.params['collection'] as string,
            ctx.params['draftId'] as string,
            input,
            ctx.requestId,
          ),
        },
      };
    },
  });

  router.add({
    method: 'POST',
    pattern: `${drafts}/:draftId/preview-link`,
    auth: 'token',
    handler: async (ctx) => ({
      status: 201,
      body: {
        data: await s.drafts.createPreviewLink(
          ctx.principal,
          ctx.params['connectionId'] as string,
          ctx.params['collection'] as string,
          ctx.params['draftId'] as string,
          ctx.requestId,
        ),
      },
    }),
  });

  // ---- Preview (no API token: the signed link is the credential) ------

  // auth "none" on purpose: the signed, expiring token in the URL is the
  // credential. Responses are no-store and noindex so links do not get
  // cached or picked up by search engines.
  router.add({
    method: 'GET',
    pattern: '/v1/preview/:token',
    auth: 'none',
    handler: async (ctx) => {
      const preview = await s.drafts.previewFor(ctx.params['token'] as string);
      return {
        status: 200,
        body: { data: preview.data, meta: preview.meta },
        headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      };
    },
  });

  router.add({
    method: 'GET',
    pattern: '/v1/preview/:token/events',
    auth: 'none',
    handler: async (ctx) => {
      const preview = await s.drafts.previewFor(ctx.params['token'] as string);
      const release = s.streams.acquire(
        `preview:${preview.claims.principalId}`,
      );
      // Streams are capped per caller so one client cannot hold all sockets.
      if (!release) {
        throw errors.rateLimited('Too many open preview streams', {
          retryAfter: 5,
        });
      }

      const stream = openEventStream(ctx.res, { 'X-Robots-Tag': 'noindex' });
      stream.send('draft', { data: preview.data, meta: preview.meta });

      const stop = s.events.subscribe((event) => {
        if (!('draftId' in event) || event.draftId !== preview.claims.draftId) {
          return;
        }
        // Re-validate the link on every update so a revoked or expired link
        // stops receiving content.
        void s.drafts.previewFor(ctx.params['token'] as string).then(
          (fresh) =>
            stream.send(event.type, { data: fresh.data, meta: fresh.meta }),
          () => {
            stream.send('closed', { reason: 'unavailable' });
            stream.close();
          },
        );
        if (event.type === 'draft.discarded') {
          stream.send('closed', { reason: event.type });
          stream.close();
        }
      });
      // The link stops working when it expires, even on an open stream.
      const expiry = setTimeout(
        () => {
          stream.send('closed', { reason: 'expired' });
          stream.close();
        },
        Math.max(1000, preview.claims.exp * 1000 - Date.now()),
      );
      expiry.unref();

      stream.onClose(() => {
        stop();
        clearTimeout(expiry);
        release();
      });
      return 'handled' as const;
    },
  });

  // ---- Live events for the admin --------------------------------------

  router.add({
    method: 'GET',
    pattern: '/v1/events',
    auth: 'token',
    handler: (ctx) => {
      // Optional filter: only events for one connection.
      const only = ctx.url.searchParams.get('connection');
      const release = s.streams.acquire(ctx.principal.id);
      if (!release) {
        throw errors.rateLimited('Too many open event streams', {
          retryAfter: 5,
        });
      }

      const stream = openEventStream(ctx.res);
      stream.send('ready', { at: new Date().toISOString() });

      const stop = s.events.subscribe((event) => {
        if (only && event.connectionId !== only) {
          return;
        }
        // Only tell people about content they are allowed to read.
        if (
          'collection' in event &&
          !canSee(s, ctx.principal, event.connectionId, event.collection)
        ) {
          return;
        }
        stream.send(event.type, event);
      });
      stream.onClose(() => {
        stop();
        release();
      });
      return 'handled';
    },
  });
}

/**
 * Can this caller see events for a collection?
 *
 * Mirrors the read check used by the records API so the live feed cannot
 * leak what a direct read would refuse.
 *
 * @returns true only if the collection is exposed and readable by them.
 */
export function canSee(
  s: Services,
  principal: Parameters<typeof tryReadAccess>[0],
  connectionId: string,
  collectionName: string,
): boolean {
  // Uses only data already in memory: events must never trigger database calls.
  const connection = s.store.read().connections[connectionId];
  if (!connection || !connection.exposed.includes(collectionName)) {
    return false;
  }
  try {
    accessFor(
      principal,
      { name: collectionName, fields: [], relations: [] },
      'read',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything an editor needs to build a form: fields, what is writable, and
 * what actions are allowed.
 */
function describeCollection(
  principal: Parameters<typeof tryReadAccess>[0],
  bound: Bound,
  collection: CollectionDefinition,
) {
  // "hide" fields are dropped and "mask" fields flagged, so the form never
  // receives values the caller may not see.
  const read = accessFor(principal, collection, 'read');
  // Write actions also need a read_write connection and a writing adapter,
  // not just role permission.
  const can = (action: 'create' | 'update' | 'delete'): boolean => {
    if (
      bound.connection.mode !== 'read_write' ||
      !bound.adapterCapabilities.writes
    ) {
      return false;
    }
    try {
      accessFor(principal, collection, action);
      return true;
    } catch {
      return false;
    }
  };

  let writable: ReadonlyMap<string, string> = new Map();
  try {
    writable = accessFor(
      principal,
      collection,
      can('update') ? 'update' : 'create',
    ).fieldWrite;
  } catch {
    // Read-only callers get no writable fields.
  }

  return {
    name: collection.name,
    fields: collection.fields
      .filter((field) => read.fieldRead.get(field.name) !== 'hide')
      .map((field) => ({
        ...field,
        masked: read.fieldRead.get(field.name) === 'mask',
        editable:
          writable.get(field.name) === 'allow' &&
          field.generated !== true &&
          field.readOnly !== true,
      })),
    relations: collection.relations,
    access: {
      create: can('create'),
      update: can('update'),
      delete: can('delete'),
    },
    capabilities: capabilitySummary(bound.adapterCapabilities),
    mode: bound.connection.mode,
  };
}
