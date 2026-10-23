/**
 * Per-person workspaces: turned on with SETHUCMS_WORKSPACES=open.
 */
import { join } from 'node:path';
import type { GatewayConfig } from '../config.js';
import { type Logger } from '../logger.js';
import { Workspaces } from '../tenancy.js';
import { FirebaseVerifier } from '../security/firebase.js';
import { SharedDb } from '../store/postgres.js';
import { type FirestoreLike } from '../store/firestore.js';
import { createGateway, type GatewayOptions } from '../gateway.js';
/**
 * Turn on workspaces when SETHUCMS_WORKSPACES=open: each person who signs in
 * with Firebase gets an isolated gateway of their own. Returns undefined when
 * it is off.
 */
export function openWorkspaces(input: {
  options: GatewayOptions;
  env: NodeJS.ProcessEnv;
  config: GatewayConfig;
  firebase: FirebaseVerifier | undefined;
  fs: FirestoreLike | undefined;
  db: SharedDb | undefined;
  logger: Logger;
}): { hub: Workspaces } | undefined {
  const { options, env, config, firebase, fs, db, logger } = input;
  const mode = (env['SETHUCMS_WORKSPACES'] ?? '').trim().toLowerCase();
  if (mode === '') {
    return undefined;
  }
  if (mode !== 'open') {
    // A typo must not quietly leave sign-in closed to everyone else.
    throw new Error(
      `SETHUCMS_WORKSPACES must be "open" (got a different value of ${mode.length} characters)`,
    );
  }
  if (!firebase || !config.firebaseAuth) {
    throw new Error(
      'SETHUCMS_WORKSPACES=open needs Firebase sign-in (SETHUCMS_FIREBASE_AUTH_PROJECT and _API_KEY)',
    );
  }
  if (db) {
    throw new Error(
      'SETHUCMS_WORKSPACES=open is not available with PostgreSQL shared state. Use Firestore or a data folder.',
    );
  }
  const firebaseConfig = config.firebaseAuth;
  const secret = (
    env['SETHUCMS_WORKSPACE_SECRET'] ||
    env['SETHUCMS_VAULT_KEY'] ||
    ''
  ).trim();
  if (secret.length < 24) {
    throw new Error(
      'SETHUCMS_WORKSPACES=open needs SETHUCMS_WORKSPACE_SECRET (24 or more random characters; create one with: openssl rand -hex 32)',
    );
  }
  // How many workspaces one instance keeps open (the idle ones beyond it are
  // closed and reopened on their next request).
  const openLimit = Math.min(
    64,
    Math.max(2, Number.parseInt(env['SETHUCMS_WORKSPACES_OPEN'] ?? '', 10) || 8),
  );
  // Workspaces share one Firestore connection; closing a workspace must not
  // close it for everyone.
  const shared = fs
    ? new Proxy(fs, {
        get(target, key) {
          if (key === 'terminate') {
            return async () => undefined;
          }
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function'
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      })
    : undefined;
  const hub: Workspaces = new Workspaces(
    Buffer.from(secret),
    (id) => {
      const prefix = config.firestore?.prefix ?? 'sethucms';
      // Only Firebase sign-in; teammates come from invitations.
      const { oidc: _oidc, github: _github, ...rest } = config;
      const own: GatewayConfig = {
        ...rest,
        // A workspace has its own state, never the main one.
        ...(config.firestore
          ? { firestore: { ...config.firestore, prefix: `${prefix}_${id}` } }
          : {}),
        dataDir:
          config.dataDir === undefined
            ? undefined
            : join(config.dataDir, 'workspaces', id),
        sqliteDir: undefined,
        // Strangers must not reach the server's own network.
        allowPrivateNetworks: false,
        seedDemo: false,
        adminDir: undefined,
        worker: false,
        firebaseAuth: { ...firebaseConfig, roles: { admin: [], editor: [], viewer: [] } },
      };
      delete own.metricsToken;
      return createGateway({
        ...options,
        schema: undefined,
        project: { id, hub },
        config: own,
        env: {
          ...env,
          SETHUCMS_WORKSPACES: '',
          // A person's own workspace has its own database; the owner's schema
          // does not apply to it.
          SETHUCMS_SCHEMA: '',
          SETHUCMS_SCHEMA_FILE: '',
          // Registers the workspace's built-in admin; nobody ever sees it.
          SETHUCMS_ADMIN_TOKEN: hub.bootstrapToken(id),
          SETHUCMS_METRICS_TOKEN: '',
        },
        ...(shared ? { firestore: shared } : {}),
        logger,
      });
    },
    openLimit,
  );
  return { hub };
}
