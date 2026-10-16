/**
 * The database types this gateway can open.
 *
 * Adding a database type means adding one entry here. The adapter itself comes
 * from the sethucms-adapters repository (or your own package).
 */
import { MemoryAdapter } from '@sethucms/adapter-memory';
import { PostgresAdapter } from '@sethucms/adapter-postgres';
import { MysqlAdapter } from '@sethucms/adapter-mysql';
import { SqliteAdapter } from '@sethucms/adapter-sqlite';
import { MongoAdapter } from '@sethucms/adapter-mongodb';
import { FirestoreAdapter } from '@sethucms/adapter-firestore';
import type { Adapter } from '@sethucms/adapter-sdk';
import { GrpcAdapter, parseAddress } from '@sethucms/adapter-sdk/grpc';
import {
  defineCollection,
  errors,
  isPlainObject,
  type CollectionDefinition,
} from '@sethucms/core';
import { demoCollections } from './demo.js';

/**
 * Describes one database type: how to build its adapter and which network
 * host it will contact (so the SSRF guard can vet it before connecting).
 */
export interface AdapterKind {
  label: string;
  /**
   * Build an adapter for these (non-secret) settings. Throws VALIDATION_FAILED
   * for bad settings.
   */
  create(config: Record<string, unknown>): Adapter;
  /**
   * The host the adapter will contact, so the network guard can vet it. Null
   * for local adapters.
   */
  networkHost(config: Record<string, unknown>): string | null;
  /** Records to insert right after connecting (demo data). */
  seed?: Record<string, Array<Record<string, unknown>>>;
  /** Whether `seed` applies for these settings. */
  wantsSeed?(config: Record<string, unknown>): boolean;
  /**
   * Set for databases without a schema that bring a collection into being
   * with its first record (Firestore). An administrator may then declare an
   * empty collection from the admin panel. `keyField` names the generated key
   * every collection of this database has. Left unset for SQL databases:
   * creating tables in someone else's database stays a migration-only step.
   */
  declareCollections?: { keyField: string };
  /**
   * Set when the adapter can keep images and PDFs in the database itself
   * (Firestore). The admin then offers an upload button, and the gateway serves
   * the files at /v1/files/...
   */
  files?: boolean;
}

// Use the demo schema unless the admin supplies their own (1-50, capped
// so a request cannot ask for an unbounded model).
function memoryCollections(
  config: Record<string, unknown>,
): CollectionDefinition[] {
  const supplied = config['collections'];
  if (supplied === undefined) {
    return demoCollections();
  }
  if (
    !Array.isArray(supplied) ||
    supplied.length === 0 ||
    supplied.length > 50
  ) {
    throw errors.validation(
      'config.collections must be a list of 1 to 50 collection definitions',
    );
  }
  return supplied.map((item) => defineCollection(item));
}

/** Gateway-wide settings that affect how adapters are built. */
export interface BuiltInOptions {
  /**
   * Folder SQLite database files must live in. Without it only in-memory SQLite
   * databases can be opened.
   */
  sqliteDir?: string | undefined;
  /**
   * Refuse plain-text gRPC connections to external adapters on other machines
   * (set in production).
   */
  requireTls?: boolean | undefined;
}

/** Read `config.host`; used by network databases for the SSRF check. */
function requireHost(config: Record<string, unknown>): string {
  const host = config['host'];
  if (typeof host !== 'string' || host.length === 0) {
    throw errors.validation('config.host is required');
  }
  return host;
}

/**
 * The registry of supported database types, keyed by the `adapterType`
 * stored on a connection.
 *
 * @param demoSeed Sample rows for the in-memory demo database, if any.
 * @param options Gateway settings (SQLite folder, TLS requirement).
 */
export function builtInAdapters(
  demoSeed: AdapterKind['seed'],
  options: BuiltInOptions = {},
): Record<string, AdapterKind> {
  return {
    memory: {
      label: 'In-memory (demo)',
      create: (config) =>
        new MemoryAdapter({ collections: memoryCollections(config) }),
      networkHost: () => null,
      ...(demoSeed ? { seed: demoSeed } : {}),
      wantsSeed: (config) => config['collections'] === undefined,
    },
    postgres: {
      label: 'PostgreSQL',
      create: () => new PostgresAdapter(),
      networkHost: requireHost,
    },
    mysql: {
      label: 'MySQL / MariaDB',
      create: () => new MysqlAdapter(),
      networkHost: requireHost,
    },
    sqlite: {
      label: 'SQLite',
      create: () =>
        new SqliteAdapter(
          options.sqliteDir ? { baseDir: options.sqliteDir } : {},
        ),
      // a file on this machine, limited to the SQLite folder
      networkHost: () => null,
    },
    mongodb: {
      label: 'MongoDB',
      create: () => new MongoAdapter(),
      networkHost: requireHost,
    },
    grpc: {
      label: 'External adapter (gRPC)',
      // Production sets requireTls so credentials never cross the network
      // in plain text to an external adapter.
      create: () =>
        new GrpcAdapter({ requireTls: options.requireTls ?? false }),
      // The address is "host:port"; the network guard vets the host like any
      // other.
      networkHost: (config) => parseAddress(config['address']).host,
    },
    firestore: {
      label: 'Firestore (Firebase)',
      create: () => new FirestoreAdapter(),
      declareCollections: { keyField: 'id' },
      files: true,
      // Real Firestore lives at Google; an emulator is on the host the
      // administrator names.
      networkHost: (config) => {
        const emulator = config['emulatorHost'];
        if (typeof emulator === 'string' && emulator.length > 0) {
          return emulator.replace(/:\d+$/, '');
        }
        return 'firestore.googleapis.com';
      },
    },
  };
}

/**
 * Require connection settings to be a plain JSON object.
 *
 * @throws A validation error otherwise.
 */
export function assertPlainConfig(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    throw errors.validation('config must be an object');
  }
  return config;
}
