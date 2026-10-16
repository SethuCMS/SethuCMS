/**
 * What `createGateway` takes and what it gives back.
 */
import { type Server } from 'node:http';
import type { GatewayConfig } from '../config.js';
import { type AdapterKind } from '../connections/adapters.js';
import { type Logger } from '../logger.js';
import { type Services } from '../routes/services.js';
import { type FirestoreLike } from '../store/firestore.js';


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
  /** The schema as an object, instead of SETHUCMS_SCHEMA / SETHUCMS_SCHEMA_FILE. */
  schema?: unknown;
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
  /** Write out pending audit entries (serverless: before the instance freezes). */
  flush(): Promise<void>;
}
