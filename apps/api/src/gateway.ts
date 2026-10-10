/**
 * The gateway: wires every part together and handles each HTTP request.
 *
 * Request pipeline, in order:
 *   1. request id, CORS, size and method checks
 *   2. route lookup (404 / 405)
 *   3. rate limit, then authentication
 *   4. idempotency for retried writes
 *   5. the route handler
 *   6. a standard error body for anything that goes wrong
 */
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { CursorCodec, errors, isSethuError } from '@sethucms/core';
import { AuditLog } from './audit.js';
import { Authenticator, type Principal } from './auth.js';
import type { GatewayConfig } from './config.js';
import { MigrationManager } from './migration/manager.js';
import { acquireDataLock } from './security/data-lock.js';
import { builtInAdapters, type AdapterKind } from './connections/adapters.js';
import { DEMO_SEED } from './connections/demo.js';
import { ConnectionRegistry } from './connections/registry.js';
import { DraftsService } from './content/drafts.js';
import { RecordsService } from './content/records.js';
import { EventBus } from './events.js';
import { Router, type RequestContext, type Route } from './http/router.js';
import {
  API_SECURITY_HEADERS,
  errorResponse,
  readJson,
  sendJson,
} from './http/respond.js';
import { serveAdmin } from './http/static.js';
import { createLogger, type Logger } from './logger.js';
import { Metrics } from './metrics.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { OidcClient } from './security/oidc.js';
import { registerContentRoutes } from './routes/content.js';
import { registerOpsRoutes } from './routes/ops.js';
import { StreamCounter, type Services } from './routes/services.js';
import { IdempotencyStore } from './security/idempotency.js';
import { NetworkGuard } from './security/network-guard.js';
import { PreviewTokens } from './security/preview-token.js';
import { RateLimiter } from './security/rate-limit.js';
import { loadSecrets } from './security/secrets.js';
import { Vault } from './security/vault.js';
import {
  FileStateStore,
  MemoryStateStore,
  type StateStore,
} from './store/state.js';
import {
  OUTBOX_CHANNEL,
  PostgresStateStore,
  SharedDb,
} from './store/postgres.js';
import { PostgresChangeStore } from './changes/postgres.js';
import {
  FirestoreAuditSink,
  FirestoreChangeStore,
  FirestoreStateStore,
  openFirestore,
  type FirestoreLike,
} from './store/firestore.js';
import {
  FileChangeStore,
  MemoryChangeStore,
  type ChangeStore,
} from './changes/store.js';
import { DeliveryWorker, matchesWebhook } from './changes/worker.js';
import { registerChangeRoutes } from './routes/changes.js';
import {
  PostgresAuditSink,
  PostgresIdempotencyStore,
  relayEvents,
} from './store/postgres-shared.js';

/** Inputs for {@link createGateway}. Only `config` is required. */
/** A running (or ready to run) gateway. */
export interface GatewayOptions {
  /** Settings, normally from `configFromEnv`. */
  config: GatewayConfig;
  /**
   * Environment for secrets and the bootstrap admin token. Defaults to
   * `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /** Replace the default logger. */
  logger?: Logger;
  /** Add or replace database types (tests, custom adapters). */
  adapters?: Record<string, AdapterKind>;
  /** Use this Firestore client instead of connecting (tests). */
  firestore?: FirestoreLike;
  /** Replace DNS lookups in the network guard (tests). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Override rate limits (tests). */
  rateLimit?: { capacity: number; refillPerSecond: number };
}

export interface Gateway {
  /** The underlying Node HTTP server. */
  server: Server;
  /** Shared services, exposed mainly for tests. */
  services: Services;
  /** Start listening. Returns the real port (useful with port 0). */
  listen(): Promise<{ host: string; port: number }>;
  /** Stop accepting requests, finish background work and release the lock. */
  close(): Promise<void>;
  /** The admin token created on first start, when one was generated. */
  generatedAdminToken: string | undefined;
}

/** Allowed shape for a supplied admin token: long enough to be unguessable. */
const ADMIN_TOKEN_PATTERN = /^[A-Za-z0-9_\-.]{32,200}$/;

/**
 * Start a gateway. With a data folder, only one gateway may use it at a time
 * (see security/data-lock.ts).
 */
export async function createGateway(options: GatewayOptions): Promise<Gateway> {
  // With shared state the database coordinates the gateways, so the data-folder
  // lock does not apply.
  // Only one process may own a data folder; with Postgres the database
  // coordinates instead, so no file lock.
  const lock =
    options.config.dataDir &&
    !options.config.stateUrl &&
    !options.config.firestore
      ? await acquireDataLock(options.config.dataDir, {
          force: (options.env ?? process.env)['SETHUCMS_FORCE_LOCK'] === '1',
        })
      : undefined;
  try {
    const gateway = await buildGateway(options);
    const close = gateway.close;
    gateway.close = async () => {
      try {
        await close();
      } finally {
        await lock?.release();
      }
    };
    return gateway;
  } catch (error) {
    await lock?.release();
    throw error;
  }
}

/**
 * Open the shared database when configured, and make sure it is closed if
 * assembly fails.
 */
async function buildGateway(options: GatewayOptions): Promise<Gateway> {
  const db = options.config.stateUrl
    ? await SharedDb.open({ url: options.config.stateUrl })
    : undefined;
  const fs = options.config.firestore
    ? (options.firestore ?? (await openFirestore(options.config.firestore)))
    : undefined;
  try {
    return await assemble(options, db, fs);
  } catch (error) {
    await db?.close();
    await fs?.terminate?.();
    throw error;
  }
}

/**
 * Create every service, register routes and build the HTTP server.
 * Order matters: secrets and stores first, then services that use them.
 */
async function assemble(
  options: GatewayOptions,
  db: SharedDb | undefined,
  fs: FirestoreLike | undefined,
): Promise<Gateway> {
  const { config } = options;
  const env = options.env ?? process.env;
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel ?? 'info',
      format: config.logFormat ?? 'json',
    });
  const slowMs = config.slowRequestMs ?? 1000;
  const metrics = new Metrics();

  // ---- Foundations ----------------------------------------------------
  // Gateways that share state must also share secrets, so these have to come
  // from the environment.
  const secrets = await loadSecrets({
    env,
    dataDir: config.dataDir,
    production: config.production || Boolean(db) || Boolean(fs),
  });
  const sharedStore = db
    ? await PostgresStateStore.open(
        db,
        config.statePollMs === undefined ? {} : { pollMs: config.statePollMs },
      )
    : undefined;
  const prefix = config.firestore?.prefix ?? 'sethucms';
  const fsStore = fs
    ? await FirestoreStateStore.open(fs, prefix, {
        force: env['SETHUCMS_FORCE_LOCK'] === '1',
      })
    : undefined;
  const store: StateStore =
    sharedStore ??
    fsStore ??
    (config.dataDir
      ? await FileStateStore.open(config.dataDir)
      : new MemoryStateStore());
  const audit = db
    ? AuditLog.shared(new PostgresAuditSink(db))
    : fs
      ? AuditLog.shared(new FirestoreAuditSink(fs, prefix))
      : await AuditLog.open(config.dataDir, {
        ...(config.auditMaxBytes === undefined
          ? {}
          : { maxBytes: config.auditMaxBytes }),
        ...(config.auditKeepFiles === undefined
          ? {}
          : { keepFiles: config.auditKeepFiles }),
      });
  const events = new EventBus();
  const vault = new Vault(secrets.vaultKey);
  // Signed cursors expire after 24 h so a leaked one is not valid forever.
  const cursors = new CursorCodec({
    secrets: [new Uint8Array(secrets.cursorSecret)],
    ttlSeconds: 24 * 3600,
  });
  const auth = new Authenticator(store);

  const networkGuard = new NetworkGuard({
    allowPrivateNetworks: config.allowPrivateNetworks,
    ...(options.resolveHost ? { resolve: options.resolveHost } : {}),
  });
  const registry = new ConnectionRegistry({
    store,
    vault,
    cursors,
    audit,
    events,
    kinds: {
      ...builtInAdapters(config.seedDemo ? DEMO_SEED : undefined, {
        sqliteDir: config.sqliteDir,
        // Production requires encrypted connections to customer databases.
        requireTls: config.production,
      }),
      ...options.adapters,
    },
    networkGuard,
  });
  const changes: ChangeStore = db
    ? new PostgresChangeStore(db)
    : fs
      ? await FirestoreChangeStore.open(fs, prefix)
      : config.dataDir
      ? await FileChangeStore.open(config.dataDir)
      : new MemoryChangeStore();
  const records = new RecordsService(registry, audit, events);
  const previews = new PreviewTokens(secrets.previewSecret);
  const drafts = new DraftsService(
    store,
    vault,
    registry,
    records,
    audit,
    events,
    previews,
    auth,
  );

  const migrations = new MigrationManager({
    registry,
    store,
    audit,
    events,
    logger,
    records: metrics.migrationRecords,
    shared: Boolean(db),
  });
  await migrations.recover();
  migrations.watchForAbandoned();
  // Other gateways' events reach our listeners; a changed connection must be
  // reopened here too.
  const stopRelay = db
    ? relayEvents(db, events, (event) => {
        if (event.type === 'connection.changed') {
          registry.invalidate(event.connectionId);
        }
      })
    : undefined;
  const router = new Router();
  const services: Services = {
    router,
    migrations,
    store,
    auth,
    registry,
    records,
    drafts,
    audit,
    events,
    changes,
    streams: new StreamCounter(),
    metrics,
    metricsToken: config.metricsToken,
  };
  registerAdminRoutes(services);
  registerAuthRoutes(services, {
    oidc: config.oidc ? new OidcClient(config.oidc) : undefined,
    vault,
    logger,
  });
  registerContentRoutes(services);
  registerOpsRoutes(services);

  // The change feed: every change made here is numbered and queued for matching
  // webhooks, in order.
  const deliveries = metrics.counter(
    'sethucms_webhook_deliveries_total',
    'Webhook delivery attempts, by result (delivered, retry, dead).',
  );
  const worker =
    config.worker === false
      ? undefined
      : new DeliveryWorker({
          store: changes,
          webhooks: () => store.read().webhooks,
          vault,
          guard: networkGuard,
          logger,
          results: deliveries,
        });
  // Chain appends so change numbers are assigned in the order events happen.
  let feed: Promise<unknown> = Promise.resolve();
  events.subscribeLocal((event) => {
    feed = feed
      .then(async () => {
        const ids = Object.values(store.read().webhooks)
          .filter((webhook) => matchesWebhook(webhook, event))
          .map((webhook) => webhook.id);
        await changes.append(event, ids);
        if (ids.length > 0) {
          worker?.nudge();
        }
      })
      .catch((error: unknown) =>
        logger.error({
          event: 'changes.append_failed',
          error: error instanceof Error ? error.message : 'unknown',
        }),
      );
  });
  // Another gateway queued a change: wake our delivery worker.
  const stopOutbox = db?.listen(OUTBOX_CHANNEL, () => worker?.nudge());
  registerChangeRoutes(services, {
    vault,
    guard: networkGuard,
    production: config.production,
    onChange: () => worker?.nudge(),
  });
  worker?.start();

  // Values read when a monitoring tool asks for them.
  events.subscribe((event) => metrics.events.inc({ type: event.type }));
  metrics.gauge(
    'sethucms_event_streams_open',
    'Open live event streams.',
    () => services.streams.open,
  );
  metrics.gauge(
    'sethucms_connections',
    'Saved database connections, by adapter type.',
    () => {
      const byAdapter = new Map<string, number>();
      for (const connection of registry.list()) {
        byAdapter.set(
          connection.adapterType,
          (byAdapter.get(connection.adapterType) ?? 0) + 1,
        );
      }
      return [...byAdapter].map(([adapter, value]) => ({
        labels: { adapter },
        value,
      }));
    },
  );
  metrics.gauge(
    'sethucms_api_tokens_active',
    'API tokens that are not revoked.',
    () =>
      Object.values(store.read().tokens).filter((token) => !token.revokedAt)
        .length,
  );
  metrics.gauge(
    'sethucms_audit_entries_total',
    'Audit entries written since the gateway started.',
    () => audit.written,
    'counter',
  );

  // ---- First start: make sure someone can sign in ---------------------
  const generatedAdminToken = await ensureAdmin(
    auth,
    env['SETHUCMS_ADMIN_TOKEN'],
    config.production,
  );
  if (config.seedDemo && registry.list().length === 0) {
    await registry.create(
      {
        name: 'Demo content',
        adapter: 'memory',
        mode: 'read_write',
        expose: 'all',
      },
      'system',
    );
  }

  // ---- Request handling -----------------------------------------------
  const limit = options.rateLimit ?? { capacity: 300, refillPerSecond: 50 };
  // Three buckets: per IP (before auth, stops anonymous floods), per token
  // (stops one client hogging), and a small one for costly operations.
  const ipLimiter = new RateLimiter(limit.capacity, limit.refillPerSecond);
  const callerLimiter = new RateLimiter(limit.capacity, limit.refillPerSecond);
  // Slow refill (one every 5 s) after a burst of 10: protects heavy routes
  // such as migrations and connection tests.
  const expensiveLimiter = new RateLimiter(10, 0.2);
  // Shared store when several gateways run, so retries are safe on any one.
  const idempotency: Pick<IdempotencyStore, 'run'> = db
    ? new PostgresIdempotencyStore(db)
    : new IdempotencyStore();
  const origins = new Set(config.allowedOrigins);

  // Per-request pipeline. Every path ends in the `finally` block that
  // records metrics and one structured log line.
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const started = Date.now();
    // Keep a caller's own request id when it is safe, so one id follows a
    // request through proxies and services.
    const inbound = req.headers['x-request-id'];
    const requestId =
      typeof inbound === 'string' && /^[A-Za-z0-9._-]{8,64}$/.test(inbound)
        ? inbound
        : randomUUID();
    const traceId = traceIdOf(req.headers['traceparent']);
    res.setHeader('X-Request-Id', requestId);
    metrics.inFlight += 1;
    let routeLabel = 'unmatched';
    // Single place that turns any thrown value into a safe response body.
    const fail = (error: unknown): ReturnType<typeof errorResponse> => {
      metrics.errors.inc({
        code: isSethuError(error) ? error.code : 'UNEXPECTED',
      });
      logIfUnexpected(logger, error, requestId);
      return errorResponse(error, requestId);
    };
    const ip = clientIp(req, config.trustProxy);
    let principal: Principal | undefined;
    let route: Route | undefined;

    try {
      const url = new URL(req.url ?? '/', 'http://gateway.local');
      if ((req.url ?? '').length > 4096) {
        throw errors.validation('URL is too long');
      }

      // CORS runs before routing so even errors carry the headers a browser
      // needs.
      applyCors(req, res, origins);
      if (req.method === 'OPTIONS') {
        sendJson(res, 204, undefined, { 'Access-Control-Max-Age': '600' });
        return;
      }

      // The admin app and everything that is not the API.
      if (!url.pathname.startsWith('/v1/')) {
        if (
          config.adminDir &&
          (req.method === 'GET' || req.method === 'HEAD') &&
          (await serveAdmin(config.adminDir, url.pathname, res))
        ) {
          routeLabel = 'static';
          return;
        }
        sendJson(res, 404, {
          error: { code: 'NOT_FOUND', message: 'Not found', requestId },
        });
        return;
      }

      const found = router.match(req.method ?? 'GET', url.pathname);
      if (!found) {
        throw errors.notFound('Not found');
      }
      if ('allowed' in found) {
        sendJson(
          res,
          405,
          {
            error: {
              code: 'METHOD_NOT_ALLOWED',
              message: 'Method not allowed',
              requestId,
            },
          },
          { Allow: found.allowed.join(', ') },
        );
        return;
      }
      route = found.route;
      routeLabel = route.pattern;

      // IP limit comes before authentication so failed logins are throttled
      // too.
      const ipWait = ipLimiter.take(ip);
      if (ipWait > 0) {
        metrics.rateLimited.inc({ scope: 'ip' });
      }
      if (ipWait > 0) {
        throw errors.rateLimited('Too many requests', { retryAfter: ipWait });
      }

      if (route.auth === 'token') {
        principal = auth.authenticate(req.headers['authorization']);
        // Second limit keyed by token id: many callers behind one IP stay fair.
        const wait = callerLimiter.take(principal.id);
        if (wait > 0) {
          metrics.rateLimited.inc({ scope: 'caller' });
        }
        if (wait > 0) {
          throw errors.rateLimited('Too many requests', { retryAfter: wait });
        }
      }
      if (route.expensive) {
        const wait = expensiveLimiter.take(principal?.id ?? ip);
        if (wait > 0) {
          metrics.rateLimited.inc({ scope: 'expensive' });
        }
        if (wait > 0) {
          throw errors.rateLimited('Too many requests for this operation', {
            retryAfter: wait,
          });
        }
      }

      // Body can be read once from the stream; cache it so idempotency
      // fingerprinting and the handler both see it.
      let cachedBody: Promise<unknown> | undefined;
      const context: RequestContext = {
        req,
        res,
        url,
        requestId,
        ip,
        params: found.params,
        principal: principal as Principal,
        json: () => (cachedBody ??= readJson(req)),
      };

      const key = req.headers['idempotency-key'];
      // Only authenticated, retry-safe routes honour Idempotency-Key. The key
      // is
      // scoped to the caller and the exact method and path.
      if (route.idempotent && typeof key === 'string' && principal) {
        const body =
          req.method === 'DELETE'
            ? null
            : await context.json().catch(() => undefined);
        // Narrowed copy: TypeScript loses the narrowing inside the closure.
        const route_ = route;
        const saved = await idempotency.run(
          principal.id,
          key,
          `${req.method} ${url.pathname}`,
          body,
          async () => {
            try {
              const result = await route_.handler(context);
              if (result === 'handled') {
                return { status: 200, body: undefined };
              }
              return { status: result.status, body: result.body };
            } catch (error) {
              const failure = fail(error);
              return { status: failure.status, body: failure.body };
            }
          },
        );
        sendJson(res, saved.status, saved.body, {
          'Idempotent-Replay': 'true',
        });
        return;
      }

      const result = await route.handler(context);
      if (result !== 'handled') {
        sendJson(res, result.status, result.body, result.headers);
      }
    } catch (error) {
      const failure = fail(error);
      if (res.headersSent) {
        res.end();
      } else {
        sendJson(res, failure.status, failure.body, failure.headers);
      }
    } finally {
      metrics.inFlight -= 1;
      const ms = Date.now() - started;
      const status = res.statusCode;
      const streaming = String(res.getHeader('content-type') ?? '').startsWith(
        'text/event-stream',
      );
      metrics.httpRequests.inc({
        method: knownMethod(req.method),
        route: routeLabel,
        status: String(status),
      });
      if (!streaming) {
        metrics.httpDuration.observe(
          { method: knownMethod(req.method), route: routeLabel },
          ms / 1000,
        );
      }

      const slow = !streaming && ms >= slowMs;
      // Auth failures and rate limits are logged at warn so abuse stands out.
      const security = status === 401 || status === 403 || status === 429;
      const level =
        status >= 500
          ? 'error'
          : security || slow
            ? 'warn'
            : routeLabel === '/v1/health' || routeLabel === '/v1/ready'
              ? 'debug'
              : 'info';
      // No query string (filters can hold personal data) and no body. The
      // address is logged only
      // for refused requests, where it is needed to spot abuse.
      logger[level]({
        event: 'http.request',
        requestId,
        ...(traceId ? { traceId } : {}),
        method: req.method,
        path: (req.url ?? '').split('?')[0],
        route: routeLabel,
        status,
        ms,
        ...(slow ? { slow: true } : {}),
        caller: principal?.id,
        role: principal?.role,
        ...(security ? { ip } : {}),
      });
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  // Timeouts and header limits blunt slow-client (slowloris) attacks.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;

  return {
    server,
    services,
    generatedAdminToken,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          const address = server.address() as AddressInfo;
          resolve({ host: address.address, port: address.port });
        });
      }),
    close: async () => {
      server.closeIdleConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Long-lived event streams would keep the server open forever.
        setTimeout(() => server.closeAllConnections(), 2000).unref();
      });
      await migrations.stop();
      await feed;
      await worker?.stop();
      stopOutbox?.();
      await changes.close();
      await registry.closeAll();
      await audit.flush();
      stopRelay?.();
      sharedStore?.stop();
      await fsStore?.release();
      await db?.close();
      await fs?.terminate?.();
      metrics.close();
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Make sure someone can sign in on first start.
 * @param auth Token service.
 * @param supplied Admin token from `SETHUCMS_ADMIN_TOKEN`, if any.
 * @param production Refuse to invent credentials when true.
 * @returns A generated token to show once, or undefined if none was made.
 * @throws Error for a malformed supplied token, or in production when no
 * admin exists and none was supplied.
 */
async function ensureAdmin(
  auth: Authenticator,
  supplied: string | undefined,
  production: boolean,
): Promise<string | undefined> {
  if (supplied) {
    if (!ADMIN_TOKEN_PATTERN.test(supplied)) {
      throw new Error(
        'SETHUCMS_ADMIN_TOKEN must be 32 to 200 characters of A-Z a-z 0-9 _ - .  (create one with: openssl rand -hex 32)',
      );
    }
    try {
      // If this token is not known yet, the catch below registers it. Only the
      // hash is stored, as for every token.
      auth.authenticate(`Bearer ${supplied}`);
    } catch {
      await auth.create('Bootstrap admin', 'admin', supplied);
    }
    return undefined;
  }
  if (auth.hasActiveAdmin()) {
    return undefined;
  }
  if (production) {
    throw new Error(
      'No admin exists. Set SETHUCMS_ADMIN_TOKEN for the first start.',
    );
  }
  // Development convenience only; production must supply its own token.
  return (await auth.create('Local admin', 'admin')).token;
}

/**
 * Caller address used for rate limiting and abuse logs.
 * Honours X-Forwarded-For only when `trustProxy` is set; otherwise any client
 * could pick its own address and escape the IP limit.
 */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      ?.trim();
    if (first) {
      return first.slice(0, 64);
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Echo the Origin back only when it is on the allow list. Never use "*",
 * because requests carry bearer tokens.
 */
function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: Set<string>,
): void {
  // Tell caches the response depends on Origin.
  res.setHeader('Vary', 'Origin');
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || !allowed.has(origin)) {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Idempotency-Key',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Request-Id, Retry-After, Idempotent-Replay',
  );
}

/** HTTP methods allowed as metric labels. */
const KNOWN_METHODS = new Set([
  'GET',
  'POST',
  'PATCH',
  'PUT',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
/**
 * Map unknown methods to "OTHER" so attackers cannot create unlimited
 * metric label values (cardinality blow-up).
 */
const knownMethod = (method: string | undefined): string =>
  method && KNOWN_METHODS.has(method) ? method : 'OTHER';

/**
 * The trace id from a W3C `traceparent` header (00-<trace id>-<span
 * id>-<flags>), or undefined.
 */
function traceIdOf(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(
    value ?? '',
  );
  return match && match[1] !== '0'.repeat(32) ? match[1] : undefined;
}

/**
 * Log server faults with their internal cause; expected client errors are
 * skipped.
 */
function logIfUnexpected(
  logger: Logger,
  error: unknown,
  requestId: string,
): void {
  if (isSethuError(error) && error.code !== 'INTERNAL') {
    return;
  }
  // Server-side only: the cause can contain database messages that clients must
  // never see.
  const cause =
    error instanceof Error
      ? error.cause instanceof Error
        ? error.cause
        : error
      : undefined;
  logger.error({
    event: 'error.unexpected',
    requestId,
    message: 'Unexpected error',
    error: cause?.message,
    stack: cause?.stack,
  });
}

// Re-exported so tests and tools can check the standard headers.
export { API_SECURITY_HEADERS };
