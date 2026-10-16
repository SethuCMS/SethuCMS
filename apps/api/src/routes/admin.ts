/**
 * Routes for administrators: connections, API tokens, the audit log, and the
 * overview the admin home page shows.
 */
import { errors, isPlainObject } from '@sethucms/core';
import { requireRole, type Principal } from '../auth.js';
import { safeMessage } from '../connections/registry.js';
import type { StoredConnection } from '../store/state.js';
import type { Services } from './services.js';
import { capabilitySummary, type CapabilitySummary } from './views.js';

// Cap on how long the home page waits for a slow database to open.
const OVERVIEW_OPEN_TIMEOUT_MS = 4000;

/**
 * Register the admin-only routes: connections, tokens, audit, migrations,
 * plus /v1/me and the health probes.
 *
 * Every admin route calls `requireRole` first, so permission is checked
 * before any body is parsed or any work is done. State-changing handlers
 * write an audit entry naming the acting token.
 *
 * @param s Shared services.
 */
export function registerAdminRoutes(s: Services): void {
  const { router } = s;

  // Any signed-in role may ask who they are.
  router.add({
    method: 'GET',
    pattern: '/v1/me',
    auth: 'token',
    handler: (ctx) => ({ status: 200, body: { data: ctx.principal } }),
  });

  router.add({
    method: 'GET',
    pattern: '/v1/admin/adapters',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return { status: 200, body: { data: s.registry.adapterTypes() } };
    },
  });

  // Open to every role, but the review queue and activity feed (which can
  // reveal other people's actions) are admin-only.
  router.add({
    method: 'GET',
    pattern: '/v1/admin/overview',
    auth: 'token',
    handler: async (ctx) => {
      // Run the per-connection summaries in parallel; each is time-boxed.
      const connections = await Promise.all(
        s.registry.list().map((connection) => summarise(s, connection)),
      );
      const reviewQueue =
        ctx.principal.role === 'admin' ? await reviewItems(s) : [];
      const activity =
        ctx.principal.role === 'admin'
          ? (await s.audit.latestAny(12)).map((entry) => ({
              id: entry.id,
              actor: entry.actor,
              operation: entry.operation,
              target: entry.target,
              at: entry.at,
            }))
          : [];
      return {
        status: 200,
        body: {
          workspaceName: 'SethuCMS',
          userName: ctx.principal.name,
          connections: connections.map((c) => c.summary),
          reviewQueue,
          activity,
        },
      };
    },
  });

  // ---- Connections ----------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/v1/admin/connections/:connectionId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const connection = s.registry.require(
        ctx.params['connectionId'] as string,
      );
      return { status: 200, body: { data: await detail(s, connection) } };
    },
  });

  // `idempotent`: clients may retry safely with an Idempotency-Key.
  router.add({
    method: 'POST',
    pattern: '/v1/admin/connections',
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Body must be a JSON object');
      }
      const created = await s.registry.create(input, ctx.principal.id);
      return { status: 201, body: { data: await detail(s, created) } };
    },
  });

  router.add({
    method: 'PATCH',
    pattern: '/v1/admin/connections/:connectionId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Body must be a JSON object');
      }
      const updated = await s.registry.update(
        ctx.params['connectionId'] as string,
        input,
        ctx.principal.id,
      );
      return { status: 200, body: { data: await detail(s, updated) } };
    },
  });

  router.add({
    method: 'DELETE',
    pattern: '/v1/admin/connections/:connectionId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      await s.registry.remove(
        ctx.params['connectionId'] as string,
        ctx.principal.id,
      );
      return { status: 204 };
    },
  });

  // `expensive`: opens a real database connection, so it gets the
  // stricter rate limit.
  router.add({
    method: 'POST',
    pattern: '/v1/admin/connections/:connectionId/test',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 200,
        body: {
          data: await s.registry.test(ctx.params['connectionId'] as string),
        },
      };
    },
  });

  router.add({
    method: 'POST',
    pattern: '/v1/admin/connections/:connectionId/refresh',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const refreshed = await s.registry.refresh(
        ctx.params['connectionId'] as string,
        ctx.principal.id,
      );
      return { status: 200, body: { data: await detail(s, refreshed) } };
    },
  });

  // Declare a new, empty collection (Firestore). The database creates it with
  // its first record, so only its definition is saved. Not offered for SQL.
  router.add({
    method: 'POST',
    pattern: '/v1/admin/connections/:connectionId/collections',
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Body must be a JSON object');
      }
      const updated = await s.registry.createCollection(
        ctx.params['connectionId'] as string,
        input,
        ctx.principal.id,
      );
      return { status: 201, body: { data: await detail(s, updated) } };
    },
  });

  // Exposing a collection is what makes it reachable through the content
  // API; nothing is public until an admin turns it on.
  router.add({
    method: 'PUT',
    pattern: '/v1/admin/connections/:connectionId/collections/:collection',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input) || typeof input['exposed'] !== 'boolean') {
        throw errors.validation('Body must be {"exposed": true | false}');
      }
      const updated = await s.registry.setExposed(
        ctx.params['connectionId'] as string,
        ctx.params['collection'] as string,
        input['exposed'],
        ctx.principal.id,
      );
      return { status: 200, body: { data: await detail(s, updated) } };
    },
  });

  // ---- Tokens ---------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/v1/admin/tokens',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return { status: 200, body: { data: s.auth.list() } };
    },
  });

  router.add({
    method: 'POST',
    pattern: '/v1/admin/tokens',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Body must be a JSON object');
      }
      // Validate every field explicitly; the body is untrusted JSON.
      const name = input['name'];
      const role = input['role'];
      if (
        typeof name !== 'string' ||
        name.trim().length === 0 ||
        name.length > 60
      ) {
        throw errors.validation('name must be 1 to 60 characters');
      }
      if (role !== 'admin' && role !== 'editor' && role !== 'viewer') {
        throw errors.validation('role must be admin, editor or viewer');
      }
      const days = input['expiresInDays'];
      if (
        days !== undefined &&
        (typeof days !== 'number' ||
          !Number.isInteger(days) ||
          days < 1 ||
          days > 3650)
      ) {
        throw errors.validation(
          'expiresInDays must be a whole number from 1 to 3650',
        );
      }
      // The `undefined` argument is the OIDC subject, unused for API tokens.
      const created = await s.auth.create(
        name.trim(),
        role,
        undefined,
        days === undefined ? {} : { expiresInDays: days as number },
      );
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'token.create',
        target: `token:${created.id}`,
        requestId: ctx.requestId,
        detail: {
          name,
          role,
          ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
        },
      });
      return {
        status: 201,
        body: {
          data: {
            id: created.id,
            token: created.token,
            ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
            // The plain token is returned only here; only a hash is kept.
            note: 'Copy this token now. It cannot be shown again.',
          },
        },
      };
    },
  });

  // Rotation issues a new token and keeps the old one alive for a grace
  // period, so clients can switch over without downtime.
  router.add({
    method: 'POST',
    pattern: '/v1/admin/tokens/:tokenId/rotate',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['tokenId'] as string;
      const input = await ctx.json().catch(() => ({}));
      const grace =
        isPlainObject(input) && input['graceMinutes'] !== undefined
          ? input['graceMinutes']
          : 60;
      if (
        typeof grace !== 'number' ||
        !Number.isInteger(grace) ||
        grace < 0 ||
        grace > 1440
      ) {
        throw errors.validation(
          'graceMinutes must be a whole number from 0 to 1440',
        );
      }
      // Stops an admin locking themselves out mid-request.
      if (id === ctx.principal.id && grace === 0) {
        throw errors.validation(
          'You cannot revoke the token you are using. Allow some grace time, or use another token',
        );
      }
      const created = await s.auth.rotate(id, grace);
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'token.rotate',
        target: `token:${id}`,
        requestId: ctx.requestId,
        detail: { newToken: created.id, graceMinutes: grace },
      });
      return {
        status: 201,
        body: {
          data: {
            id: created.id,
            token: created.token,
            ...(created.expiresAt ? { expiresAt: created.expiresAt } : {}),
            replaces: id,
            graceMinutes: grace,
            note: 'Copy this token now. It cannot be shown again.',
          },
        },
      };
    },
  });

  router.add({
    method: 'DELETE',
    pattern: '/v1/admin/tokens/:tokenId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['tokenId'] as string;
      // Same self-lockout guard as rotate.
      if (id === ctx.principal.id) {
        throw errors.validation('You cannot revoke the token you are using');
      }
      await s.auth.revoke(id);
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'token.revoke',
        target: `token:${id}`,
        requestId: ctx.requestId,
      });
      return { status: 204 };
    },
  });

  // ---- Audit log ------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/v1/admin/audit',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      // Clamp the limit to 1..500 so a caller cannot ask for the whole log.
      const requested = Number(ctx.url.searchParams.get('limit') ?? 50);
      const limit = Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), 500)
        : 50;
      return { status: 200, body: { data: await s.audit.latestAny(limit) } };
    },
  });

  router.add({
    // Reads every audit file and checks the hash chain. Admin only, and counted
    // as an expensive call.
    method: 'GET',
    pattern: '/v1/admin/audit/verify',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      return { status: 200, body: { data: await s.audit.verify() } };
    },
  });

  // ---- Migration: copy data from one connection to another -------------

  router.add({
    // Dry run: checks everything and writes nothing.
    method: 'POST',
    pattern: '/v1/admin/migrations/plan',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 200,
        body: { data: await s.migrations.plan(await ctx.json()) },
      };
    },
  });

  // Starting a migration is long-running work: answer 202 and let the
  // caller poll the migration id.
  router.add({
    method: 'POST',
    pattern: '/v1/admin/migrations',
    auth: 'token',
    expensive: true,
    idempotent: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 202,
        body: {
          data: await s.migrations.start(await ctx.json(), ctx.principal.id),
        },
      };
    },
  });

  router.add({
    method: 'GET',
    pattern: '/v1/admin/migrations',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return { status: 200, body: { data: s.migrations.list() } };
    },
  });

  router.add({
    method: 'GET',
    pattern: '/v1/admin/migrations/:migrationId',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 200,
        body: { data: s.migrations.get(ctx.params['migrationId'] as string) },
      };
    },
  });

  router.add({
    method: 'POST',
    pattern: '/v1/admin/migrations/:migrationId/cancel',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 200,
        body: {
          data: s.migrations.cancel(
            ctx.params['migrationId'] as string,
            ctx.principal.id,
          ),
        },
      };
    },
  });

  // ---- Health ---------------------------------------------------------

  router.add({
    method: 'GET',
    pattern: '/v1/health',
    auth: 'none',
    handler: () => ({ status: 200, body: { status: 'ok' } }),
  });
  router.add({
    method: 'GET',
    pattern: '/v1/ready',
    auth: 'none',
    handler: () => ({
      status: 200,
      body: { status: 'ready', connections: s.registry.list().length },
    }),
  });
}

// ---------------------------------------------------------------------------

// Card fields shared by the overview and the connection page.
type Summary = ReturnType<typeof baseSummary>;

/** Build the cheap, no-I/O part of a connection card from saved state. */
function baseSummary(s: Services, connection: StoredConnection) {
  const health = s.registry.healthOf(connection.id);
  return {
    id: connection.id,
    name: connection.name,
    adapter: connection.adapterType,
    adapterLabel: s.registry.kindLabel(connection.adapterType),
    mode: connection.mode,
    health:
      health.status === 'healthy'
        ? ('healthy' as const)
        : health.status === 'error'
          ? ('error' as const)
          : ('pending' as const),
    ...(health.note ? { healthNote: health.note } : {}),
    lastCheckedAt: health.at,
    collections: {
      exposed: connection.exposed.length,
      total: connection.known.length,
    },
  };
}

// Placeholder shown when a connection cannot be opened.
const NO_CAPABILITIES: CapabilitySummary = {
  joins: false,
  transactions: 'none',
  filterOr: false,
  inequality: 'none',
  fullText: false,
  realtime: false,
  writes: false,
};

/**
 * Connection card for the home page. Opens the connection if needed, but never
 * waits long.
 */
// Race the open against a timeout so one dead database cannot stall the
// whole overview; the card then falls back to the saved health note.
async function summarise(
  s: Services,
  connection: StoredConnection,
): Promise<{ summary: Summary & { capabilities: CapabilitySummary } }> {
  let capabilities = NO_CAPABILITIES;
  let total = connection.known.length;
  try {
    const bound = await Promise.race([
      s.registry.bind(connection.id),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('slow')),
          OVERVIEW_OPEN_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    capabilities = capabilitySummary(bound.adapterCapabilities);
    total = bound.discovered.length;
  } catch {
    // The card shows the saved health note instead.
  }
  const summary = baseSummary(s, connection);
  return {
    summary: {
      ...summary,
      collections: { exposed: connection.exposed.length, total },
      capabilities,
    },
  };
}

/**
 * Collections found in a database but not yet reviewed by an admin.
 * Skips connections that are not already open.
 */
async function reviewItems(s: Services) {
  const items: Array<{
    id: string;
    connectionId: string;
    connectionName: string;
    collection: string;
    fieldCount: number;
    discoveredAt: string;
  }> = [];
  for (const connection of s.registry.list()) {
    if (!s.registry.isOpen(connection.id)) {
      continue;
    } // never open databases just to build a list
    try {
      for (const collection of await s.registry.discovered(connection.id)) {
        if (connection.known.includes(collection.name)) {
          continue;
        }
        items.push({
          id: `${connection.id}:${collection.name}`,
          connectionId: connection.id,
          connectionName: connection.name,
          collection: collection.name,
          fieldCount: collection.fields.length,
          discoveredAt: connection.updatedAt,
        });
      }
    } catch {
      // Skip connections that are down.
    }
  }
  return items;
}

/**
 * Full connection page: settings, health, and every collection with its
 * exposure.
 */
async function detail(s: Services, connection: StoredConnection) {
  const health = s.registry.healthOf(connection.id);
  let collections: Array<{
    name: string;
    exposed: boolean;
    reviewed: boolean;
    fields: number;
    primaryKey: string | null;
  }> = [];
  let capabilities = NO_CAPABILITIES;
  let error: string | undefined;
  try {
    const bound = await s.registry.bind(connection.id);
    capabilities = capabilitySummary(bound.adapterCapabilities);
    collections = bound.discovered.map((collection) => ({
      name: collection.name,
      exposed: connection.exposed.includes(collection.name),
      reviewed: connection.known.includes(collection.name),
      fields: collection.fields.length,
      primaryKey:
        collection.fields.find((field) => field.primaryKey)?.name ?? null,
    }));
    // `safeMessage` strips connection strings and credentials from the text.
  } catch (cause) {
    error = safeMessage(cause);
  }
  return {
    id: connection.id,
    name: connection.name,
    adapter: connection.adapterType,
    adapterLabel: s.registry.kindLabel(connection.adapterType),
    mode: connection.mode,
    config: connection.config,
    // Only a yes/no is returned; stored credentials never leave the server.
    hasCredentials: connection.credentials !== null,
    health: health.status,
    ...((error ?? health.note) ? { healthNote: error ?? health.note } : {}),
    lastCheckedAt: health.at,
    // Whether the admin panel should offer "Create collection".
    canCreateCollections: s.registry.canCreateCollections(connection),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
    capabilities,
    collections,
  };
}

// Type-only re-export of the caller identity type.
export type { Principal };
