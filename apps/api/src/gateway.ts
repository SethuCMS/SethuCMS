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
import { startChangeFeed } from './boot/change-feed.js';
import { registerGauges } from './boot/gauges.js';
import { recordRequest } from './boot/access-log.js';
import { ensureAdmin } from './boot/admin.js';
import { openWorkspaces } from './boot/workspaces.js';
import {
  applyCors,
  clientIp,
  logIfUnexpected,
  traceIdOf,
} from './boot/http-helpers.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { CursorCodec, errors, isSethuError } from '@sethucms/core';
import { AuditLog } from './audit.js';
import { Authenticator, type Principal } from './auth.js';
import { MigrationManager } from './migration/manager.js';
import { acquireDataLock } from './security/data-lock.js';
import { builtInAdapters } from './connections/adapters.js';
import { DEMO_SEED } from './connections/demo.js';
import { ConnectionRegistry } from './connections/registry.js';
import { DraftsService } from './content/drafts.js';
import { RecordsService } from './content/records.js';
import { EventBus } from './events.js';
import { Router, type RequestContext, type Route } from './http/router.js';
import { errorResponse, readJson, sendJson } from './http/respond.js';
import { serveAdmin } from './http/static.js';
import { createLogger } from './logger.js';
import { Metrics } from './metrics.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGithubRoutes } from './routes/github.js';
import { GithubClient } from './security/github.js';
import { registerFirebaseRoutes } from './routes/firebase.js';
import { loadSchema } from './schema/code.js';
import { registerSchemaRoutes } from './routes/schema.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { Workspaces } from './tenancy.js';
import { FirebaseVerifier } from './security/firebase.js';
import { registerInviteRoutes } from './routes/invites.js';
import { registerPeopleRoutes } from './routes/people.js';
import { OidcClient } from './security/oidc.js';
import { registerContentRoutes } from './routes/content.js';
import { registerFileRoutes } from './routes/files.js';
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
import { PostgresStateStore, SharedDb } from './store/postgres.js';
import { PostgresChangeStore } from './changes/postgres.js';
import {
  FirestoreAuditSink,
  FirestoreChangeStore,
  FirestoreStateStore,
  SharedFirestoreStateStore,
  openFirestore,
  type FirestoreLike,
} from './store/firestore.js';
import {
  FileChangeStore,
  MemoryChangeStore,
  type ChangeStore,
} from './changes/store.js';
import {
  PostgresAuditSink,
  PostgresIdempotencyStore,
  relayEvents,
} from './store/postgres-shared.js';

import type { Gateway, GatewayOptions } from './boot/types.js';
export type { Gateway, GatewayOptions } from './boot/types.js';

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
  // A wrong schema file stops the start rather than showing the wrong form.
  const codeSchema = await loadSchema(env, options.schema);
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
  const fsStore = !fs
    ? undefined
    : config.serverless
      ? await SharedFirestoreStateStore.open(fs, prefix, {
          staleMs: config.statePollMs ?? 1000,
        })
      : await FirestoreStateStore.open(fs, prefix, {
          force: env['SETHUCMS_FORCE_LOCK'] === '1',
        });
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
    ...(codeSchema ? { schema: codeSchema } : {}),
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
      ? config.serverless
        ? new MemoryChangeStore()
        : await FirestoreChangeStore.open(fs, prefix)
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
    schema: codeSchema,
  };
  // Workspaces: every person who signs in gets a gateway of their own.
  const firebaseVerifier = config.firebaseAuth
    ? new FirebaseVerifier(config.firebaseAuth)
    : undefined;
  const workspaces = openWorkspaces({
    options,
    env,
    config,
    firebase: firebaseVerifier,
    fs,
    db,
    logger,
  });
  registerAdminRoutes(services);
  registerAuthRoutes(services, {
    oidc: config.oidc ? new OidcClient(config.oidc) : undefined,
    github: Boolean(config.github),
    ...(config.firebaseAuth
      ? {
          firebase: {
            apiKey: config.firebaseAuth.web.apiKey,
            authDomain: config.firebaseAuth.web.authDomain,
            projectId: config.firebaseAuth.projectId,
            providers: config.firebaseAuth.providers,
            ...(workspaces ? { workspaces: true } : {}),
          },
        }
      : {}),
    vault,
    logger,
  });
  registerFirebaseRoutes(services, {
    firebase: firebaseVerifier,
    logger,
  });
  if (workspaces && firebaseVerifier) {
    registerWorkspaceRoutes(services, {
      firebase: firebaseVerifier,
      workspaces: workspaces.hub,
      logger,
    });
  }
  registerGithubRoutes(services, {
    github: config.github ? new GithubClient(config.github) : undefined,
    vault,
    logger,
  });
  registerPeopleRoutes(services, { vault, logger });
  registerInviteRoutes(services);
  registerContentRoutes(services);
  registerSchemaRoutes(services);
  registerFileRoutes(services);
  registerOpsRoutes(services);

  const changeFeed = startChangeFeed({
    config,
    services,
    metrics,
    changes,
    store,
    vault,
    networkGuard,
    logger,
    events,
    db,
  });
  registerGauges({ metrics, events, services, registry, store, audit });

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

      // Serverless: pick up changes other instances saved, before anything
      // reads the state (one cheap read at most every statePollMs).
      await store.fresh?.();

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

      // These need a process that stays up; refuse them instead of losing data.
      if (
        config.serverless &&
        (url.pathname === '/v1/changes' ||
          url.pathname === '/v1/events' ||
          url.pathname.endsWith('/events') ||
          url.pathname.startsWith('/v1/admin/webhooks'))
      ) {
        sendJson(res, 501, {
          error: {
            code: 'NOT_SUPPORTED',
            message:
              'Live events, the change feed and webhooks are not available when the gateway runs serverless',
            requestId,
          },
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
      recordRequest({
        metrics,
        logger,
        slowMs,
        req,
        res,
        started,
        routeLabel,
        requestId,
        traceId,
        principal,
        ip,
      });
    }
  };

  const server = createServer((req, res) => {
    // /w/<workspace>/... belongs to that workspace's own gateway.
    if (workspaces && (req.url ?? '').startsWith('/w/')) {
      void workspaces.hub.handle(req, res).then((done) => {
        if (!done) {
          void handle(req, res);
        }
      });
      return;
    }
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
    flush: async () => {
      await audit.flush();
      await workspaces?.hub.flush();
    },
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
      await workspaces?.hub.close();
      await migrations.stop();
      await changeFeed.drain();
      await changeFeed.worker?.stop();
      changeFeed.stopOutbox?.();
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

