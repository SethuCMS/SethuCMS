/**
 * The shapes the connection registry hands out and receives.
 */
import { type CollectionUi, type LoadedSchema } from '../schema/code.js';
import { GuardedAdapter, type Adapter } from '@sethucms/adapter-sdk';
import {
  ContentModel,
  CursorCodec,
  type Capabilities,
  type CollectionDefinition,
} from '@sethucms/core';
import type { AuditLog } from '../audit.js';
import type { EventBus } from '../events.js';
import type { NetworkGuard } from '../security/network-guard.js';
import type { Vault } from '../security/vault.js';
import type { StateStore, StoredConnection } from '../store/state.js';
import { type AdapterKind } from './adapters.js';


/** Last known state of a connection; `pending` means never checked. */
export type Health = 'healthy' | 'error' | 'pending';

/**
 * A connection ready for request handlers: the guarded adapter plus the
 * content model limited to exposed collections.
 */
export interface Bound {
  connection: StoredConnection;
  guarded: GuardedAdapter;
  /** Only the collections editors may see. */
  model: ContentModel;
  /** Everything found in the database, exposed or not. */
  discovered: CollectionDefinition[];
  /** What the connection can do right now (writes are off when read-only). */
  capabilities: Capabilities;
  /** What the database adapter can do, regardless of the connection mode. */
  adapterCapabilities: Capabilities;
  /** How the schema file wants each collection shown (empty without one). */
  ui: Map<string, CollectionUi>;
  /** Where the schema file and this database disagree. */
  schemaNotes: string[];
}

// An open adapter and its cached schema snapshot.
export interface Live {
  adapter: Adapter;
  discovered: CollectionDefinition[];
  /** When the structure was last re-read to catch a collection made elsewhere. */
  checkedAt?: number;
}

/** Everything the registry needs; injected for testing. */
export interface RegistryDeps {
  store: StateStore;
  vault: Vault;
  cursors: CursorCodec;
  kinds: Record<string, AdapterKind>;
  networkGuard: NetworkGuard;
  audit: AuditLog;
  events: EventBus;
  /** Longest a single database call may take. */
  timeoutMs?: number;
  /** How the schema file wants collections edited, when there is one. */
  schema?: LoadedSchema;
}



// Bounds memory and open database pools.
export const MAX_CONNECTIONS = 50;
