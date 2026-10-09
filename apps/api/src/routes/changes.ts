/**
 * The change feed and webhooks.
 *
 *   GET    /v1/changes?since=<seq>&limit=<n>
 *                       what happened after number <seq> (resume from here)
 *   GET    /v1/admin/webhooks                  list (secrets never shown)
 *   POST   /v1/admin/webhooks                  create; secret returned once
 *   PATCH  /v1/admin/webhooks/:id              switch on or off, rename,
 *                                              change which events
 *   DELETE /v1/admin/webhooks/:id
 *   GET    /v1/admin/webhooks/:id/deliveries   recent attempts (status codes,
 *                                              short errors)
 */
import { randomBytes } from 'node:crypto';
import { errors, isPlainObject } from '@sethucms/core';
import type { Vault } from '../security/vault.js';
import type { NetworkGuard } from '../security/network-guard.js';
import type { StoredWebhook } from '../store/state.js';
import { requireRole } from '../auth.js';
import { canSee } from './content.js';
import type { Services } from './services.js';

// Event types a webhook may subscribe to; "*" (all) is also accepted.
const EVENT_TYPES = [
  'record.created',
  'record.updated',
  'record.deleted',
  'draft.created',
  'draft.updated',
  'draft.discarded',
  'draft.published',
  'connection.changed',
];
// Cap keeps fan-out per event bounded.
const MAX_WEBHOOKS = 50;

/**
 * Register the change feed and webhook management routes.
 *
 * @param s Shared services.
 * @param deps `vault` encrypts signing secrets at rest; `guard` blocks
 *   private/internal destination addresses (SSRF); `production` forbids
 *   plain http; `onChange` tells the delivery worker config changed.
 */
export function registerChangeRoutes(
  s: Services,
  deps: {
    vault: Vault;
    guard: NetworkGuard;
    production: boolean;
    onChange(): void;
  },
): void {
  const { router } = s;

  // Poll-and-resume: pass the last `next` back as `since`. Results are
  // filtered per caller, so `next` can skip over hidden events.
  router.add({
    method: 'GET',
    pattern: '/v1/changes',
    auth: 'token',
    handler: async (ctx) => {
      const since = whole(
        ctx.url.searchParams.get('since'),
        0,
        0,
        Number.MAX_SAFE_INTEGER,
        'since',
      );
      const limit = whole(
        ctx.url.searchParams.get('limit'),
        100,
        1,
        500,
        'limit',
      );
      const [records, head, oldest] = await Promise.all([
        s.changes.since(since, limit),
        s.changes.head(),
        s.changes.oldest(),
      ]);
      // Only events about content this caller may read, like the live event
      // stream.
      const visible = records.filter(({ event }) =>
        'collection' in event
          ? canSee(s, ctx.principal, event.connectionId, event.collection)
          : ctx.principal.role === 'admin',
      );
      return {
        status: 200,
        body: {
          data: visible.map(({ seq, at, event }) => ({ seq, at, ...event })),
          // Continue from here. It advances past events this caller may not
          // see.
          next:
            records.length > 0
              ? (records[records.length - 1] as { seq: number }).seq
              : since,
          head,
          // True when events between `since` and the oldest kept one were
          // removed, so a full re-read may be needed.
          gap: oldest > 0 && since + 1 < oldest,
        },
      };
    },
  });

  // Strip the encrypted signing secret from anything sent to a client.
  const view = (webhook: StoredWebhook) => {
    const { secret: _secret, ...rest } = webhook;
    return rest;
  };

  router.add({
    method: 'GET',
    pattern: '/v1/admin/webhooks',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 200,
        body: { data: Object.values(s.store.read().webhooks).map(view) },
      };
    },
  });

  // The signing secret is generated here and shown exactly once. Receivers
  // use it to verify the HMAC signature on each delivery.
  router.add({
    method: 'POST',
    pattern: '/v1/admin/webhooks',
    auth: 'token',
    idempotent: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Send a JSON object');
      }
      if (Object.keys(s.store.read().webhooks).length >= MAX_WEBHOOKS) {
        throw errors.validation(
          `At most ${MAX_WEBHOOKS} webhooks are supported`,
        );
      }

      const name = text(input['name'], 'name', 80);
      // Validate the destination up front (scheme, credentials, SSRF guard).
      const url = await checkUrl(input['url'], deps.guard, deps.production);
      const events = parseEvents(input['events']);
      const connectionId = optionalText(
        input['connectionId'],
        'connectionId',
        64,
      );
      const collection = optionalText(input['collection'], 'collection', 64);
      if (collection && !connectionId) {
        throw errors.validation('collection needs a connectionId');
      }
      if (connectionId) {
        s.registry.require(connectionId);
      }

      const id = `wh_${randomBytes(5).toString('hex')}`;
      // Random per webhook; stored only encrypted, bound to this webhook id so
      // a ciphertext cannot be swapped between webhooks.
      const plainSecret = `whsec_${randomBytes(24).toString('base64url')}`;
      const stored: StoredWebhook = {
        id,
        name,
        url,
        secret: deps.vault.encrypt(plainSecret, `webhook:${id}`),
        events,
        active: true,
        ...(connectionId ? { connectionId } : {}),
        ...(collection ? { collection } : {}),
        createdAt: new Date().toISOString(),
        createdBy: ctx.principal.id,
      };
      await s.store.update((state) => {
        state.webhooks[id] = stored;
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'webhook.create',
        target: `webhook:${id}`,
        requestId: ctx.requestId,
        detail: { name, host: new URL(url).host, events },
      });
      deps.onChange();
      return {
        status: 201,
        body: {
          data: {
            ...view(stored),
            secret: plainSecret,
            note: 'Keep the secret now: it is not shown again.',
          },
        },
      };
    },
  });

  // URL is re-checked on change, otherwise PATCH would bypass the SSRF guard.
  router.add({
    method: 'PATCH',
    pattern: '/v1/admin/webhooks/:id',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['id'] as string;
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Send a JSON object');
      }
      const url =
        input['url'] === undefined
          ? undefined
          : await checkUrl(input['url'], deps.guard, deps.production);
      const updated = await s.store.update((state) => {
        const webhook = state.webhooks[id];
        if (!webhook) {
          throw errors.notFound('Webhook not found');
        }
        if (input['name'] !== undefined) {
          webhook.name = text(input['name'], 'name', 80);
        }
        if (input['active'] !== undefined) {
          if (typeof input['active'] !== 'boolean') {
            throw errors.validation('active must be true or false');
          }
          webhook.active = input['active'];
        }
        if (input['events'] !== undefined) {
          webhook.events = parseEvents(input['events']);
        }
        if (url) {
          webhook.url = url;
        }
        // Return a copy so the caller cannot mutate live state.
        return structuredClone(webhook);
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'webhook.update',
        target: `webhook:${id}`,
        requestId: ctx.requestId,
        detail: { active: updated.active },
      });
      deps.onChange();
      return { status: 200, body: { data: view(updated) } };
    },
  });

  router.add({
    method: 'DELETE',
    pattern: '/v1/admin/webhooks/:id',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['id'] as string;
      await s.store.update((state) => {
        if (!state.webhooks[id]) {
          throw errors.notFound('Webhook not found');
        }
        delete state.webhooks[id];
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'webhook.delete',
        target: `webhook:${id}`,
        requestId: ctx.requestId,
      });
      return { status: 204 };
    },
  });

  router.add({
    method: 'GET',
    pattern: '/v1/admin/webhooks/:id/deliveries',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['id'] as string;
      if (!s.store.read().webhooks[id]) {
        throw errors.notFound('Webhook not found');
      }
      const limit = whole(
        ctx.url.searchParams.get('limit'),
        50,
        1,
        200,
        'limit',
      );
      return {
        status: 200,
        body: { data: await s.changes.deliveries(id, limit) },
      };
    },
  });
}

/**
 * Parse an optional whole-number query parameter within [min, max].
 *
 * @returns `fallback` when the parameter is absent.
 * @throws A validation error if it is not an integer in range.
 */
function whole(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (raw === null || raw === '') {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw errors.validation(
      `${name} must be a whole number from ${min} to ${max}`,
    );
  }
  return n;
}

/** Require a non-empty trimmed string of at most `max` characters. */
function text(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max
  ) {
    throw errors.validation(`${name} must be 1 to ${max} characters`);
  }
  return value.trim();
}

/** Like `text`, but undefined/null mean "not provided". */
function optionalText(
  value: unknown,
  name: string,
  max: number,
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : text(value, name, max);
}

/**
 * Validate an event-type list; absent means all events (`["*"]`).
 * Only known names are accepted so typos fail loudly instead of
 * silently never matching.
 */
function parseEvents(value: unknown): string[] {
  if (value === undefined) {
    return ['*'];
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > EVENT_TYPES.length
  ) {
    throw errors.validation('events must be a list of event types, or ["*"]');
  }
  const list = [...new Set(value)];
  for (const item of list) {
    if (item !== '*' && !EVENT_TYPES.includes(item as string)) {
      throw errors.validation(
        `Unknown event type "${String(item).slice(0, 40)}". Use one of: ${EVENT_TYPES.join(', ')}, or "*"`,
      );
    }
  }
  return list as string[];
}

/**
 * Validate a webhook destination URL.
 *
 * @returns The normalised URL.
 * @throws A validation error for non-web URLs, embedded credentials,
 *   plain http in production, or hosts the network guard refuses.
 */
async function checkUrl(
  value: unknown,
  guard: NetworkGuard,
  production: boolean,
): Promise<string> {
  if (typeof value !== 'string' || value.length > 2048) {
    throw errors.validation('url must be a web address');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw errors.validation('url must be a web address');
  }
  // Credentials in a URL would be stored and logged in plain text.
  if (url.username || url.password) {
    throw errors.validation(
      'Do not put a user name or password in the address',
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !production)) {
    throw errors.validation(
      production
        ? 'url must start with https://'
        : 'url must start with https:// (or http:// outside production)',
    );
  }
  // SSRF defence: refuses loopback, private and link-local hosts. Strip
  // IPv6 brackets so the guard sees a bare address.
  await guard.assertAllowed(url.hostname.replace(/^\[|\]$/g, ''));
  return url.toString();
}
