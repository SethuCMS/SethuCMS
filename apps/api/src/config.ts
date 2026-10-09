/**
 * Gateway settings. Everything comes from environment variables so the same
 * build runs on a laptop, in Docker and in Kubernetes.
 */
import type { OidcConfig } from './security/oidc.js';
import { parseLogLevel, type LogFormat, type LogLevel } from './logger.js';

/** Resolved gateway settings. Build with {@link configFromEnv}. */
export interface GatewayConfig {
  /**
   * Where state, audit log and development secrets are kept. Undefined keeps
   * everything in memory.
   */
  // "memory" opts out of disk entirely (tests, throwaway runs).
  dataDir: string | undefined;
  /** True when NODE_ENV=production. Turns on stricter defaults. */
  production: boolean;
  /** Browser origins allowed to call the API from another address. */
  allowedOrigins: string[];
  /**
   * Let connections reach private networks (needed for a database on your own
   * network or laptop).
   */
  allowPrivateNetworks: boolean;
  /** Believe X-Forwarded-For. Only turn on behind a proxy you control. */
  trustProxy: boolean;
  /** Folder with the built admin app. When set, the gateway serves it. */
  adminDir: string | undefined;
  /** Add a demo "memory" connection on first start. */
  seedDemo: boolean;
  /**
   * Folder SQLite database files may live in. Default: a "sqlite" folder inside
   * the data folder. Without either, only in-memory SQLite works.
   */
  sqliteDir?: string | undefined;
  /** Address to listen on. */
  host: string;
  /** TCP port to listen on. */
  port: number;
  /**
   * Lowest level written to the log: debug, info, warn or error. Default info.
   */
  logLevel?: LogLevel;
  /**
   * "json" (one object per line) or "pretty" (readable). Default: pretty at a
   * terminal outside production, otherwise json.
   */
  logFormat?: LogFormat;
  /** Requests slower than this are logged as warnings. Default 1000 ms. */
  slowRequestMs?: number;
  /** Rotate the audit log at this many bytes. Default 10 MB. */
  auditMaxBytes?: number;
  /** Rotated audit files to keep. Default 5. */
  auditKeepFiles?: number;
  /**
   * Lets a metrics scraper read /v1/metrics without an admin token. Optional.
   */
  metricsToken?: string;
  /**
   * PostgreSQL connection string. When set, several gateways share state, the
   * audit log, retried-request answers and live events through that database.
   * The data-folder lock is not used then, and the secrets must come from the
   * environment.
   */
  stateUrl?: string;
  /**
   * How often a gateway checks for state changed by another gateway. Default
   * 1000 ms.
   */
  statePollMs?: number;
  /**
   * Run the webhook delivery worker inside the gateway. Default true. Set
   * SETHUCMS_WORKER=off when a separate worker process (node
   * dist/src/worker.js) does the delivering.
   */
  worker?: boolean;
  /**
   * Single sign-on with OpenID Connect. Off unless SETHUCMS_OIDC_ISSUER is set.
   */
  oidc?: OidcConfig;
}

/** Read a boolean env value ("1", "true", "yes", "on" are true). */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Read an integer env value within [min, max].
 * @throws Error naming the variable when the value is out of range.
 */
function whole(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

/**
 * Build the gateway config from environment variables.
 * Fails fast on bad values so a typo is caught at startup, not at runtime.
 *
 * @param env Usually `process.env`.
 * @returns The validated config.
 * @throws Error describing the first invalid setting.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): GatewayConfig {
  const production = env['NODE_ENV'] === 'production';
  const port = Number(env['PORT'] ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be a number from 0 to 65535');
  }

  return {
    dataDir:
      env['SETHUCMS_DATA_DIR'] === 'memory'
        ? undefined
        : (env['SETHUCMS_DATA_DIR'] ?? './.sethucms-data'),
    production,
    sqliteDir:
      env['SETHUCMS_SQLITE_DIR'] ||
      (env['SETHUCMS_DATA_DIR'] === 'memory'
        ? undefined
        : `${env['SETHUCMS_DATA_DIR'] ?? './.sethucms-data'}/sqlite`),
    allowedOrigins: (env['SETHUCMS_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Private networks are open by default only outside production, so a
    // production gateway cannot be pointed at internal hosts by accident.
    allowPrivateNetworks: flag(
      env['SETHUCMS_ALLOW_PRIVATE_NETWORKS'],
      !production,
    ),
    // Off by default: trusting X-Forwarded-For without a proxy lets clients
    // fake their IP and dodge rate limits.
    trustProxy: flag(env['SETHUCMS_TRUST_PROXY'], false),
    adminDir: env['SETHUCMS_ADMIN_DIR'] || undefined,
    seedDemo: flag(env['SETHUCMS_SEED_DEMO'], !production),
    // Bind to all interfaces only in production (containers); loopback
    // keeps a dev machine private.
    host: env['HOST'] ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port,
    logLevel: parseLogLevel(env['SETHUCMS_LOG_LEVEL']),
    logFormat: logFormat(env['SETHUCMS_LOG_FORMAT'], production),
    slowRequestMs: whole(
      'SETHUCMS_SLOW_REQUEST_MS',
      env['SETHUCMS_SLOW_REQUEST_MS'],
      1000,
      1,
      600_000,
    ),
    auditMaxBytes:
      whole(
        'SETHUCMS_AUDIT_MAX_MB',
        env['SETHUCMS_AUDIT_MAX_MB'],
        10,
        1,
        10_240,
      ) *
      1024 *
      1024,
    auditKeepFiles: whole(
      'SETHUCMS_AUDIT_KEEP',
      env['SETHUCMS_AUDIT_KEEP'],
      5,
      1,
      100,
    ),
    ...metrics(env['SETHUCMS_METRICS_TOKEN']),
    ...shared(env),
    ...oidc(env, production),
    worker: flag(env['SETHUCMS_WORKER'], true),
  };
}

/**
 * Settings for running several gateways on one PostgreSQL database.
 * Empty when SETHUCMS_STATE_URL is unset.
 */
function shared(env: NodeJS.ProcessEnv): {
  stateUrl?: string;
  statePollMs?: number;
} {
  const url = env['SETHUCMS_STATE_URL'];
  if (!url) {
    return {};
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error(
      'SETHUCMS_STATE_URL must be a PostgreSQL connection string (postgres://user:password@host:5432/database)',
    );
  }
  return {
    stateUrl: url,
    statePollMs: whole(
      'SETHUCMS_STATE_POLL_MS',
      env['SETHUCMS_STATE_POLL_MS'],
      1000,
      100,
      60_000,
    ),
  };
}

/** Split a comma-separated env value into trimmed, non-empty items. */
const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Single sign-on settings. Empty when SETHUCMS_OIDC_ISSUER is unset;
 * otherwise the related variables are required.
 */
function oidc(
  env: NodeJS.ProcessEnv,
  production: boolean,
): { oidc?: OidcConfig } {
  const issuer = env['SETHUCMS_OIDC_ISSUER'];
  if (!issuer) {
    return {};
  }
  const need = (name: string): string => {
    const value = env[name];
    if (!value) {
      throw new Error(`${name} is required when SETHUCMS_OIDC_ISSUER is set`);
    }
    return value;
  };
  const publicUrl = need('SETHUCMS_PUBLIC_URL').replace(/\/+$/, '');
  // Redirect URIs and session cookies must not travel over plain HTTP.
  if (production && !publicUrl.startsWith('https://')) {
    throw new Error(
      'SETHUCMS_PUBLIC_URL must start with https:// in production',
    );
  }
  const roles = {
    admin: csv(env['SETHUCMS_OIDC_ADMIN_VALUES']),
    editor: csv(env['SETHUCMS_OIDC_EDITOR_VALUES']),
    viewer: csv(env['SETHUCMS_OIDC_VIEWER_VALUES']),
  };
  const defaultRole = env['SETHUCMS_OIDC_DEFAULT_ROLE'];
  if (defaultRole && !['admin', 'editor', 'viewer'].includes(defaultRole)) {
    throw new Error(
      'SETHUCMS_OIDC_DEFAULT_ROLE must be admin, editor or viewer',
    );
  }
  // Admin is never a fallback: it must be granted explicitly through the
  // identity provider's claims, so a new SSO user cannot become admin.
  if (defaultRole === 'admin') {
    throw new Error(
      'SETHUCMS_OIDC_DEFAULT_ROLE cannot be admin: list who is an admin in SETHUCMS_OIDC_ADMIN_VALUES',
    );
  }
  if (
    !defaultRole &&
    roles.admin.length + roles.editor.length + roles.viewer.length === 0
  ) {
    throw new Error(
      'Single sign-on needs at least one of SETHUCMS_OIDC_ADMIN_VALUES, SETHUCMS_OIDC_EDITOR_VALUES, SETHUCMS_OIDC_VIEWER_VALUES or SETHUCMS_OIDC_DEFAULT_ROLE, or nobody could sign in',
    );
  }
  return {
    oidc: {
      issuer,
      clientId: need('SETHUCMS_OIDC_CLIENT_ID'),
      ...(env['SETHUCMS_OIDC_CLIENT_SECRET']
        ? { clientSecret: env['SETHUCMS_OIDC_CLIENT_SECRET'] }
        : {}),
      redirectUri: `${publicUrl}/v1/auth/oidc/callback`,
      scopes: env['SETHUCMS_OIDC_SCOPES'] || 'openid email profile',
      roleClaim: env['SETHUCMS_OIDC_ROLE_CLAIM'] || 'groups',
      roles,
      ...(defaultRole
        ? { defaultRole: defaultRole as 'editor' | 'viewer' }
        : {}),
      // Lower-case so the later comparison with e-mail domains is
      // case-insensitive.
      allowedDomains: csv(env['SETHUCMS_OIDC_ALLOWED_DOMAINS']).map((domain) =>
        domain.toLowerCase(),
      ),
      // Short sessions by default (8 h): SSO tokens are not revoked at the
      // identity provider when they expire here.
      sessionHours: whole(
        'SETHUCMS_OIDC_SESSION_HOURS',
        env['SETHUCMS_OIDC_SESSION_HOURS'],
        8,
        1,
        168,
      ),
      adminUrl: env['SETHUCMS_ADMIN_URL'] || `${publicUrl}/`,
    },
  };
}

/** Pick the log format: pretty at a dev terminal, JSON otherwise. */
function logFormat(value: string | undefined, production: boolean): LogFormat {
  if (value === undefined || value === '') {
    return !production && process.stderr.isTTY ? 'pretty' : 'json';
  }
  if (value === 'json' || value === 'pretty') {
    return value;
  }
  throw new Error('SETHUCMS_LOG_FORMAT must be json or pretty');
}

/** Validate the optional metrics scrape token. */
function metrics(token: string | undefined): { metricsToken?: string } {
  if (!token) {
    return {};
  }
  // Require a long token: it is a bearer secret for an unauthenticated
  // endpoint, so it must resist guessing.
  if (!/^[A-Za-z0-9_\-.]{32,200}$/.test(token)) {
    throw new Error(
      'SETHUCMS_METRICS_TOKEN must be 32 to 200 characters of A-Z a-z 0-9 _ - .  (create one with: openssl rand -hex 32)',
    );
  }
  return { metricsToken: token };
}
