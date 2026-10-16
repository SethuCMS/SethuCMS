/**
 * The shapes the migration manager keeps and hands out, and its limits.
 */
import type { Adapter } from '@sethucms/adapter-sdk';
import { errors, type CollectionDefinition } from '@sethucms/core';
import type { AuditLog } from '../audit.js';
import type { ConnectionRegistry } from '../connections/registry.js';
import type { EventBus } from '../events.js';
import type { Logger } from '../logger.js';
import type { Counter } from '../metrics.js';
import type { StateStore, StoredConnection } from '../store/state.js';
import { type CollectionSpec, type MigrationPlan } from './plan.js';


// Everything a run needs, produced once by `prepare` so a dry run and a real
// run work from the same checked plan.
export interface Prepared {
  plan: MigrationPlan;
  source: {
    connection: StoredConnection;
    adapter: Adapter;
    discovered: CollectionDefinition[];
  };
  target: {
    connection: StoredConnection;
    adapter: Adapter;
    discovered: CollectionDefinition[];
  };
  sourceDefs: Map<string, CollectionDefinition>;
  targetDefs: Map<string, CollectionDefinition>;
  specs: Map<string, CollectionSpec>;
  /** Source collection names whose target collection will be created. */
  toCreate: Set<string>;
}

/** Final or current state of a migration job. */
export type JobStatus =
  'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

/** Live counters for one collection of a job. */
export interface CollectionProgress {
  from: string;
  to: string;
  state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  total: number | null;
  read: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /**
   * Stored records whose values differ from what was sent (checked after each
   * write).
   */
  differences: number;
  /**
   * After the copy: how many records the target gained, against how many were
   * created.
   */
  verified: boolean | null;
  note?: string;
}

/**
 * One failed record. Holds ids and short reasons only, never record
 * values, so job history cannot leak content.
 */
export interface JobError {
  collection: string;
  /** The record's id in the source. */
  id: string;
  code: string;
  message: string;
}

/** A migration run as shown to admins; also what is saved as history. */
export interface MigrationJob {
  id: string;
  status: JobStatus;
  actor: string;
  source: string;
  target: string;
  onConflict: string;
  startedAt: string;
  finishedAt?: string;
  collections: CollectionProgress[];
  errors: JobError[];
  /** True when more errors happened than are listed. */
  errorsTruncated: boolean;
  message?: string;
  /**
   * Refreshed while the job runs. With shared state it tells other gateways the
   * job is alive.
   */
  heartbeatAt?: string;
}

// In-process handle for a running job. `cancel` is checked between records.
export interface Run {
  job: MigrationJob;
  cancel: boolean;
  done: Promise<void>;
}

// Per-call limits: a database call is abandoned after 30s; only transient
// connection failures are retried.
export const CALL_TIMEOUT_MS = 30_000;
export const MAX_KEPT_JOBS = 50;
export const MAX_LISTED_ERRORS = 100;
export const RETRY_CODES = new Set(['TIMEOUT', 'CONNECTION_FAILED']);

/** Dependencies of `MigrationManager`. */
export interface MigrationDeps {
  registry: ConnectionRegistry;
  /** Where job history is kept, so it survives a restart. */
  store: StateStore;
  audit: AuditLog;
  events: EventBus;
  logger: Logger;
  records: Counter;
  /**
   * Several gateways share the saved state: a running job may belong to another
   * gateway.
   */
  shared?: boolean;
}
