/**
 * What a database can and cannot do.
 *
 * Databases differ a lot (DynamoDB has no OR, Firestore limits inequalities).
 * Instead of pretending they are all the same, each adapter declares its
 * capabilities honestly and the platform refuses queries it cannot run.
 *
 * Defaults are restrictive: an adapter must opt in to every feature.
 */

import { errors } from './errors.js';

/** Level of transaction support: none, one document, or many documents. */
export type TransactionSupport = 'none' | 'single-document' | 'multi-document';

/** Whether range/not-equal filters work on all, one, or no fields per query. */
export type InequalitySupport = 'full' | 'single-field' | 'none';

/** Which fields can be sorted: any, only indexed ones, or just the key. */
export type SortSupport = 'any-field' | 'indexed-only' | 'key-only';

/** Whether the database enforces a schema or it is inferred from data. */
export type SchemaMode = 'enforced' | 'inferred';

/**
 * Features a database adapter declares. The platform checks these before
 * running a query.
 */
export interface Capabilities {
  joins: boolean;
  transactions: TransactionSupport;
  filters: {
    or: boolean;
    inequality: InequalitySupport;
    fullText: boolean;
  };
  sort: SortSupport;
  pagination: {
    cursor: true;
    offset: boolean;
  };
  aggregations: boolean;
  realtime: boolean;
  schema: SchemaMode;
  writes: boolean;
}

// Each database adapter starts with only the features
// that are safe to assume across different databases.
// Frozen so no adapter can change the shared defaults at runtime.
export const DEFAULT_CAPABILITIES: Capabilities = Object.freeze({
  joins: false,
  transactions: 'none',
  filters: Object.freeze({
    or: false,
    inequality: 'none',
    fullText: false,
  }),
  sort: 'key-only',
  // Cursor paging is always on; only offset paging is optional.
  pagination: Object.freeze({
    cursor: true,
    offset: false,
  }),
  aggregations: false,
  realtime: false,
  schema: 'inferred',
  writes: false,
}) as Capabilities;

type CapabilityOverrides = Partial<
  Omit<Capabilities, 'filters' | 'pagination'>
> & {
  filters?: Partial<Capabilities['filters']>;
  pagination?: {
    offset?: boolean;
  };
};

/**
 * Creates a capability configuration using the defaults
 * and any features supported by the database adapter.
 *
 * @param options Features this adapter supports; the rest stay off.
 * @returns A frozen capability set.
 */
export function defineCapabilities(
  options: CapabilityOverrides = {},
): Capabilities {
  return Object.freeze({
    ...DEFAULT_CAPABILITIES,
    ...options,
    filters: Object.freeze({
      ...DEFAULT_CAPABILITIES.filters,
      ...options.filters,
    }),
    pagination: Object.freeze({
      cursor: true,
      offset: options.pagination?.offset ?? false,
    }),
  }) as Capabilities;
}

// These presets are starting points. An adapter should
// update them after checking the actual database features.
/** Ready-made capability sets for common database families. */
export const PRESETS = {
  sql: defineCapabilities({
    joins: true,
    transactions: 'multi-document',
    filters: {
      or: true,
      inequality: 'full',
      fullText: false,
    },
    sort: 'any-field',
    pagination: { offset: true },
    aggregations: true,
    schema: 'enforced',
    writes: true,
  }),

  mongodb: defineCapabilities({
    joins: false,
    transactions: 'multi-document',
    filters: {
      or: true,
      inequality: 'full',
      fullText: true,
    },
    sort: 'indexed-only',
    pagination: { offset: true },
    aggregations: true,
    realtime: true,
    schema: 'inferred',
    writes: true,
  }),

  firestore: defineCapabilities({
    joins: false,
    transactions: 'multi-document',
    filters: {
      or: true,
      inequality: 'single-field',
      fullText: false,
    },
    sort: 'indexed-only',
    aggregations: true,
    realtime: true,
    schema: 'inferred',
    writes: true,
  }),

  dynamodb: defineCapabilities({
    joins: false,
    transactions: 'multi-document',
    filters: {
      or: false,
      inequality: 'single-field',
      fullText: false,
    },
    sort: 'key-only',
    schema: 'inferred',
    writes: true,
  }),
} as const;

/**
 * Disables writes when the connection is read-only.
 *
 * @param capabilities Capabilities declared by the adapter.
 * @param readOnly True when the connection is configured read-only.
 * @returns The same object, or a frozen copy with writes off.
 */
export function applyReadOnly(
  capabilities: Capabilities,
  readOnly: boolean,
): Capabilities {
  if (!readOnly) {
    return capabilities;
  }

  return Object.freeze({
    ...capabilities,
    writes: false,
  }) as Capabilities;
}

/**
 * Prevents write operations when the adapter does not
 * support writes or the connection is read-only.
 *
 * @param capabilities Capabilities after read-only has been applied.
 * @throws SethuError READ_ONLY when writes are disabled.
 */
export function assertWritesAllowed(capabilities: Capabilities): void {
  if (!capabilities.writes) {
    throw errors.readOnly();
  }
}
