/**
 * Gateway settings. Everything comes from environment variables so the same
 * build runs on a laptop, in Docker and in Kubernetes.
 */
import type { OidcConfig } from './security/oidc.js';
import type { GithubConfig } from './security/github.js';
import {
  FIREBASE_JWKS_URL,
  type FirebaseAuthConfig,
} from './security/firebase.js';
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
  /**
   * Sign in with GitHub. Off unless SETHUCMS_GITHUB_CLIENT_ID is set.
   */
  github?: GithubConfig;
  /**
   * Sign in through Firebase Authentication (Google, GitHub). Off unless
   * SETHUCMS_FIREBASE_AUTH_PROJECT is set.
   */
  firebaseAuth?: FirebaseAuthConfig;
  /**
   * Keep the gateway's state in Firestore instead of files or PostgreSQL.
   * Set with SETHUCMS_FIRESTORE_PROJECT. One gateway process at a time (a
   * lease in the database refuses a second one); use PostgreSQL to run several.
   */
  /**
   * Run as short-lived instances (Vercel and similar): no lease, state shared
   * through Firestore with a version counter, no worker, no live events,
   * webhooks or change feed. Needs `firestore`. SETHUCMS_SERVERLESS=1.
   */
  serverless?: boolean;
  firestore?: {
    projectId: string;
    prefix: string;
    credentialsJson?: string;
    emulatorHost?: string;
  };
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
    ...github(env, production),
    ...firebaseAuth(env),
    worker: flag(env['SETHUCMS_WORKER'], true),
    ...firestoreState(env),
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

/**
 * Settings for keeping state in Firestore. Empty when
 * SETHUCMS_FIRESTORE_PROJECT is unset.
 * @throws Error when combined with SETHUCMS_STATE_URL, or on a bad prefix.
 */
function firestoreState(env: NodeJS.ProcessEnv): {
  firestore?: NonNullable<GatewayConfig['firestore']>;
  serverless?: boolean;
  worker?: boolean;
  statePollMs?: number;
} {
  const projectId = env['SETHUCMS_FIRESTORE_PROJECT'];
  if (!projectId) {
    if (flag(env['SETHUCMS_SERVERLESS'], false)) {
      throw new Error(
        'SETHUCMS_SERVERLESS needs SETHUCMS_FIRESTORE_PROJECT: the state must live in Firestore',
      );
    }
    return {};
  }
  if (env['SETHUCMS_STATE_URL']) {
    throw new Error(
      'Set either SETHUCMS_STATE_URL (PostgreSQL) or SETHUCMS_FIRESTORE_PROJECT (Firestore) for the gateway state, not both',
    );
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) {
    throw new Error(
      'SETHUCMS_FIRESTORE_PROJECT must be a Google Cloud project id (lowercase letters, digits and "-")',
    );
  }
  const prefix = env['SETHUCMS_FIRESTORE_PREFIX'] || 'sethucms';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(prefix)) {
    throw new Error(
      'SETHUCMS_FIRESTORE_PREFIX must start with a letter and use only letters, digits, "_" and "-" (up to 41 characters)',
    );
  }
  const serverless = flag(env['SETHUCMS_SERVERLESS'], false);
  const credentialsJson = env['SETHUCMS_FIRESTORE_CREDENTIALS_JSON'];
  const emulatorHost = env['SETHUCMS_FIRESTORE_EMULATOR_HOST'];
  return {
    firestore: {
      projectId,
      prefix,
      ...(credentialsJson ? { credentialsJson } : {}),
      ...(emulatorHost ? { emulatorHost } : {}),
    },
    ...(serverless
      ? {
          serverless: true,
          worker: false,
          statePollMs: whole(
            'SETHUCMS_STATE_POLL_MS',
            env['SETHUCMS_STATE_POLL_MS'],
            1000,
            0,
            60_000,
          ),
        }
      : {}),
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
  if (env['SETHUCMS_GOOGLE_CLIENT_ID']) {
    if (issuer) {
      throw new Error(
        'Set SETHUCMS_OIDC_ISSUER or SETHUCMS_GOOGLE_CLIENT_ID, not both: the gateway has one OpenID Connect provider',
      );
    }
    return { oidc: google(env, production) };
  }
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

/** The public address of this gateway, which the sign-in redirect points back to. */
function publicBase(
  env: NodeJS.ProcessEnv,
  production: boolean,
  because: string,
): string {
  const value = env['SETHUCMS_PUBLIC_URL'];
  if (!value) {
    throw new Error(`SETHUCMS_PUBLIC_URL is required when ${because}`);
  }
  const base = value.replace(/\/+$/, '');
  if (production && !base.startsWith('https://')) {
    throw new Error(
      'SETHUCMS_PUBLIC_URL must start with https:// in production',
    );
  }
  return base;
}

/**
 * Sign in with Google, the short way. Google is an OpenID Connect provider, so
 * this fills in the same settings as SETHUCMS_OIDC_* would. Google has no
 * groups, so people are listed by e-mail address:
 *
 *   SETHUCMS_GOOGLE_CLIENT_ID / SETHUCMS_GOOGLE_CLIENT_SECRET   from Google Cloud
 *   SETHUCMS_GOOGLE_ADMINS / _EDITORS / _VIEWERS                comma-separated e-mails
 *   SETHUCMS_GOOGLE_DOMAINS                                     optional: only these domains
 *
 * An address counts only when Google reports it as verified.
 */
function google(env: NodeJS.ProcessEnv, production: boolean): OidcConfig {
  const base = publicBase(
    env,
    production,
    'SETHUCMS_GOOGLE_CLIENT_ID is set',
  );
  const secret = env['SETHUCMS_GOOGLE_CLIENT_SECRET'];
  if (!secret) {
    throw new Error(
      'SETHUCMS_GOOGLE_CLIENT_SECRET is required when SETHUCMS_GOOGLE_CLIENT_ID is set',
    );
  }
  const people = (name: string): string[] =>
    csv(env[name]).map((item) => item.toLowerCase());
  const roles = {
    admin: people('SETHUCMS_GOOGLE_ADMINS'),
    editor: people('SETHUCMS_GOOGLE_EDITORS'),
    viewer: people('SETHUCMS_GOOGLE_VIEWERS'),
  };
  if (roles.admin.length + roles.editor.length + roles.viewer.length === 0) {
    throw new Error(
      'Google sign-in needs at least one e-mail address in SETHUCMS_GOOGLE_ADMINS, SETHUCMS_GOOGLE_EDITORS or SETHUCMS_GOOGLE_VIEWERS, or nobody could sign in',
    );
  }
  return {
    issuer: 'https://accounts.google.com',
    clientId: env['SETHUCMS_GOOGLE_CLIENT_ID'] as string,
    clientSecret: secret,
    redirectUri: `${base}/v1/auth/oidc/callback`,
    scopes: 'openid email profile',
    roleClaim: 'email',
    roles,
    allowedDomains: people('SETHUCMS_GOOGLE_DOMAINS'),
    sessionHours: whole(
      'SETHUCMS_OIDC_SESSION_HOURS',
      env['SETHUCMS_OIDC_SESSION_HOURS'],
      8,
      1,
      168,
    ),
    adminUrl: env['SETHUCMS_ADMIN_URL'] || `${base}/`,
  };
}

/**
 * Sign in with GitHub. Off unless SETHUCMS_GITHUB_CLIENT_ID is set.
 *
 *   SETHUCMS_GITHUB_CLIENT_ID / SETHUCMS_GITHUB_CLIENT_SECRET   from the OAuth app
 *   SETHUCMS_GITHUB_ADMINS / _EDITORS / _VIEWERS                user names or id:<number>
 *
 * There is no default role: someone who is not listed is refused, because
 * anyone in the world can have a GitHub account.
 */
function github(
  env: NodeJS.ProcessEnv,
  production: boolean,
): { github?: GithubConfig } {
  const clientId = env['SETHUCMS_GITHUB_CLIENT_ID'];
  if (!clientId) {
    return {};
  }
  const base = publicBase(env, production, 'SETHUCMS_GITHUB_CLIENT_ID is set');
  const clientSecret = env['SETHUCMS_GITHUB_CLIENT_SECRET'];
  if (!clientSecret) {
    throw new Error(
      'SETHUCMS_GITHUB_CLIENT_SECRET is required when SETHUCMS_GITHUB_CLIENT_ID is set',
    );
  }
  const roles = {
    admin: csv(env['SETHUCMS_GITHUB_ADMINS']),
    editor: csv(env['SETHUCMS_GITHUB_EDITORS']),
    viewer: csv(env['SETHUCMS_GITHUB_VIEWERS']),
  };
  if (roles.admin.length + roles.editor.length + roles.viewer.length === 0) {
    throw new Error(
      'GitHub sign-in needs at least one name in SETHUCMS_GITHUB_ADMINS, SETHUCMS_GITHUB_EDITORS or SETHUCMS_GITHUB_VIEWERS, or nobody could sign in',
    );
  }
  for (const entry of Object.values(roles).flat()) {
    if (!/^(id:[0-9]+|[A-Za-z0-9-]{1,39})$/.test(entry)) {
      throw new Error(
        `"${entry}" is not a GitHub user name or id:<number> (in SETHUCMS_GITHUB_ADMINS, _EDITORS or _VIEWERS)`,
      );
    }
  }
  return {
    github: {
      clientId,
      clientSecret,
      redirectUri: `${base}/v1/auth/github/callback`,
      roles,
      sessionHours: whole(
        'SETHUCMS_GITHUB_SESSION_HOURS',
        env['SETHUCMS_GITHUB_SESSION_HOURS'],
        8,
        1,
        168,
      ),
      adminUrl: env['SETHUCMS_ADMIN_URL'] || `${base}/`,
      webUrl: env['SETHUCMS_GITHUB_URL'] || 'https://github.com',
      apiUrl: env['SETHUCMS_GITHUB_API_URL'] || 'https://api.github.com',
    },
  };
}

/**
 * Sign in through Firebase Authentication. Off unless
 * SETHUCMS_FIREBASE_AUTH_PROJECT is set.
 *
 *   SETHUCMS_FIREBASE_AUTH_PROJECT   Firebase project id
 *   SETHUCMS_FIREBASE_AUTH_API_KEY   the project's public web API key
 *   SETHUCMS_FIREBASE_AUTH_DOMAIN    optional, default <project>.firebaseapp.com
 *   SETHUCMS_FIREBASE_ADMINS / _EDITORS / _VIEWERS   e-mails or uid:<uid>
 *   SETHUCMS_FIREBASE_DOMAINS        optional: only these e-mail domains
 *   SETHUCMS_FIREBASE_PROVIDERS      default google.com,github.com
 */
function firebaseAuth(env: NodeJS.ProcessEnv): { firebaseAuth?: FirebaseAuthConfig } {
  const projectId = env['SETHUCMS_FIREBASE_AUTH_PROJECT'];
  if (!projectId) {
    return {};
  }
  const apiKey = env['SETHUCMS_FIREBASE_AUTH_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'SETHUCMS_FIREBASE_AUTH_API_KEY is required when SETHUCMS_FIREBASE_AUTH_PROJECT is set',
    );
  }
  const lower = (name: string): string[] =>
    csv(env[name]).map((item) => item.toLowerCase());
  const roles = {
    admin: lower('SETHUCMS_FIREBASE_ADMINS'),
    editor: lower('SETHUCMS_FIREBASE_EDITORS'),
    viewer: lower('SETHUCMS_FIREBASE_VIEWERS'),
  };
  if (roles.admin.length + roles.editor.length + roles.viewer.length === 0) {
    throw new Error(
      'Firebase sign-in needs at least one entry in SETHUCMS_FIREBASE_ADMINS, SETHUCMS_FIREBASE_EDITORS or SETHUCMS_FIREBASE_VIEWERS, or nobody could sign in',
    );
  }
  const providers = csv(env['SETHUCMS_FIREBASE_PROVIDERS']);
  return {
    firebaseAuth: {
      projectId,
      web: {
        apiKey,
        authDomain:
          env['SETHUCMS_FIREBASE_AUTH_DOMAIN'] || `${projectId}.firebaseapp.com`,
      },
      roles,
      allowedDomains: lower('SETHUCMS_FIREBASE_DOMAINS'),
      providers: providers.length > 0 ? providers : ['google.com', 'github.com'],
      sessionHours: whole(
        'SETHUCMS_FIREBASE_SESSION_HOURS',
        env['SETHUCMS_FIREBASE_SESSION_HOURS'],
        8,
        1,
        168,
      ),
      jwksUrl: FIREBASE_JWKS_URL,
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
