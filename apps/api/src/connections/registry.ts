/**
 * The connection registry: every database this gateway is connected to.
 *
 * It saves connections (with encrypted credentials), opens adapters on first
 * use, keeps them open, works out which collections editors may see, and wraps
 * each adapter in the GuardedAdapter safety layer.
 *
 * Many connections can be live at the same time, each with its own adapter,
 * connection pool, capabilities and exposed collections.
 */
import { randomUUID } from 'node:crypto';
import { GuardedAdapter, type Adapter } from '@sethucms/adapter-sdk';
import {
  ContentModel,
  CursorCodec,
  applyReadOnly,
  errors,
  isSethuError,
  isPlainObject,
  isSensitiveKey,
  type Capabilities,
  type CollectionDefinition,
} from '@sethucms/core';
import type { AuditLog } from '../audit.js';
import type { EventBus } from '../events.js';
import type { NetworkGuard } from '../security/network-guard.js';
import type { Vault } from '../security/vault.js';
import type {
  ConnectionMode,
  StateStore,
  StoredConnection,
} from '../store/state.js';
import { assertPlainConfig, type AdapterKind } from './adapters.js';

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
}

// An open adapter and its cached schema snapshot.
interface Live {
  adapter: Adapter;
  discovered: CollectionDefinition[];
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
}

// Bounds memory and open database pools.
const MAX_CONNECTIONS = 50;

/**
 * Owns every configured database connection: saving, opening, caching and
 * closing adapters.
 *
 * Open adapters are cached as promises, so concurrent first requests share
 * one connection attempt. Health is kept in memory only.
 */
export class ConnectionRegistry {
  // Promise cache: stores the in-flight open too, preventing duplicate pools.
  private readonly live = new Map<string, Promise<Live>>();
  private readonly health = new Map<
    string,
    { status: Health; note?: string; at: string }
  >();

  constructor(private readonly deps: RegistryDeps) {}

  // ---- Reading --------------------------------------------------------

  /** All saved connections (credentials stay encrypted). */
  list(): StoredConnection[] {
    return Object.values(this.deps.store.read().connections);
  }

  /** Get a saved connection or throw not found. */
  require(id: string): StoredConnection {
    const connection = this.deps.store.read().connections[id];
    if (!connection) {
      throw errors.notFound('Connection not found');
    }
    return connection;
  }

  /** Last known health; "pending" before the first attempt. */
  healthOf(id: string): { status: Health; note?: string; at: string } {
    return (
      this.health.get(id) ?? {
        status: 'pending',
        at: new Date(0).toISOString(),
      }
    );
  }

  /** Human name for an adapter type, falling back to its id. */
  kindLabel(adapterType: string): string {
    return this.deps.kinds[adapterType]?.label ?? adapterType;
  }

  /** Adapter types an admin can pick when creating a connection. */
  adapterTypes(): Array<{ id: string; label: string }> {
    return Object.entries(this.deps.kinds).map(([id, kind]) => ({
      id,
      label: kind.label,
    }));
  }

  /**
   * The safe-to-use view of a connection: guarded adapter plus the collections
   * it exposes.
   */
  async bind(id: string): Promise<Bound> {
    const connection = this.require(id);
    const live = await this.open(id);

    const exposed = new Set(connection.exposed);
    const model = new ContentModel(exposedSubset(live.discovered, exposed));
    const guarded = new GuardedAdapter({
      adapter: live.adapter,
      model,
      cursors: this.deps.cursors,
      // Read-only is enforced in the guard layer, not just hidden in the UI.
      readOnly: connection.mode !== 'read_write',
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
    });
    return {
      connection,
      guarded,
      model,
      discovered: live.discovered,
      capabilities: applyReadOnly(
        live.adapter.capabilities(),
        connection.mode !== 'read_write',
      ),
      adapterCapabilities: live.adapter.capabilities(),
    };
  }

  /**
   * The open adapter with NO exposure filter and NO read-only guard. Only for
   * administrator-level jobs such as migration, which apply their own checks.
   * Never hand this to request handlers that serve editors.
   */
  async raw(id: string): Promise<{
    connection: StoredConnection;
    adapter: Adapter;
    discovered: CollectionDefinition[];
  }> {
    const connection = this.require(id);
    const live = await this.open(id);
    return { connection, adapter: live.adapter, discovered: live.discovered };
  }

  // ---- Changing -------------------------------------------------------

  /**
   * Add a connection. The settings are tested by really connecting first, so
   * a bad connection is never saved.
   *
   * @param input `{ name, adapter, mode?, config?, credentials?, expose? }`.
   * @param actor Id of the acting admin, for the audit log.
   * @throws A validation error for bad input; a connection error if the
   *   database cannot be reached or the host is blocked by the network guard.
   */
  async create(
    input: Record<string, unknown>,
    actor: string,
  ): Promise<StoredConnection> {
    if (this.list().length >= MAX_CONNECTIONS) {
      throw errors.validation(
        `At most ${MAX_CONNECTIONS} connections are supported`,
      );
    }

    const name = requireText(input['name'], 'name', 80);
    const adapterType = requireText(input['adapter'], 'adapter', 40);
    const kind = this.kind(adapterType);
    const mode = parseMode(input['mode']);
    const config = cleanConfig(input['config']);
    const credentials =
      input['credentials'] === undefined
        ? {}
        : assertPlainConfig(input['credentials']);
    // Nothing is exposed unless an admin asks; new data is private by default.
    const expose = input['expose'] === 'all' ? 'all' : 'none';

    const id = `conn_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    const probe = await this.connectNew(kind, config, credentials, id, mode);
    const discovered = probe.discovered.map((collection) => collection.name);

    const now = new Date().toISOString();
    const connection: StoredConnection = {
      id,
      name,
      adapterType,
      mode,
      config,
      credentials:
        Object.keys(credentials).length === 0
          ? null
          : this.deps.vault.encryptJson(credentials, id),
      exposed: expose === 'all' ? discovered : [],
      known: expose === 'all' ? discovered : [],
      createdAt: now,
      updatedAt: now,
    };

    await this.deps.store.update((state) => {
      state.connections[id] = connection;
    });
    this.live.set(id, Promise.resolve(probe));
    this.health.set(id, { status: 'healthy', at: now });
    this.deps.audit.record({
      actor,
      operation: 'connection.create',
      target: `connection:${id}`,
      // Audit gets `config` only. Credentials are never logged.
      detail: { name, adapterType, mode, config },
    });
    this.deps.events.publish({ type: 'connection.changed', connectionId: id });
    return connection;
  }

  /**
   * Change the name, mode or settings. New settings are tested before they are
   * saved.
   */
  async update(
    id: string,
    patch: {
      name?: unknown;
      mode?: unknown;
      config?: unknown;
      credentials?: unknown;
    },
    actor: string,
  ): Promise<StoredConnection> {
    const current = this.require(id);
    const kind = this.kind(current.adapterType);

    const name =
      patch.name === undefined
        ? current.name
        : requireText(patch.name, 'name', 80);
    const mode =
      patch.mode === undefined ? current.mode : parseMode(patch.mode);
    const config =
      patch.config === undefined ? current.config : cleanConfig(patch.config);
    const credentials =
      patch.credentials === undefined
        ? this.credentialsOf(current)
        : assertPlainConfig(patch.credentials);

    // Re-test only when something that affects the connection changed.
    const needsReconnect =
      patch.config !== undefined ||
      patch.credentials !== undefined ||
      mode !== current.mode;
    let probe: Live | undefined;
    if (needsReconnect) {
      probe = await this.connectNew(kind, config, credentials, id, mode);
    }

    const updated = await this.deps.store.update((state) => {
      const stored = state.connections[id];
      if (!stored) {
        throw errors.notFound('Connection not found');
      }
      stored.name = name;
      stored.mode = mode;
      stored.config = config;
      stored.credentials =
        Object.keys(credentials).length === 0
          ? null
          : this.deps.vault.encryptJson(credentials, id);
      stored.updatedAt = new Date().toISOString();
      if (probe) {
        // Keep only exposure choices that still exist.
        const names = new Set(
          probe.discovered.map((collection) => collection.name),
        );
        stored.exposed = stored.exposed.filter((collection) =>
          names.has(collection),
        );
      }
      return structuredClone(stored);
    });

    if (probe) {
      const previous = this.live.get(id);
      this.live.set(id, Promise.resolve(probe));
      void previous?.then((old) => old.adapter.close()).catch(() => undefined);
      this.health.set(id, { status: 'healthy', at: new Date().toISOString() });
    }
    this.deps.audit.record({
      actor,
      operation: 'connection.update',
      target: `connection:${id}`,
      detail: { name, mode, config },
    });
    this.deps.events.publish({ type: 'connection.changed', connectionId: id });
    return updated;
  }

  /** Delete a connection and every draft that belonged to it. */
  async remove(id: string, actor: string): Promise<void> {
    this.require(id);
    await this.deps.store.update((state) => {
      delete state.connections[id];
      for (const [draftId, draft] of Object.entries(state.drafts)) {
        if (draft.connectionId === id) {
          delete state.drafts[draftId];
        }
      }
    });
    const live = this.live.get(id);
    this.live.delete(id);
    this.health.delete(id);
    void live?.then((value) => value.adapter.close()).catch(() => undefined);
    this.deps.audit.record({
      actor,
      operation: 'connection.delete',
      target: `connection:${id}`,
    });
    this.deps.events.publish({ type: 'connection.changed', connectionId: id });
  }

  /**
   * Show or hide one collection. Deciding either way takes it out of the review
   * queue.
   */
  async setExposed(
    id: string,
    collection: string,
    exposed: boolean,
    actor: string,
  ): Promise<StoredConnection> {
    const live = await this.open(id);
    if (!live.discovered.some((found) => found.name === collection)) {
      throw errors.notFound('Unknown collection');
    }

    const updated = await this.deps.store.update((state) => {
      const stored = state.connections[id];
      if (!stored) {
        throw errors.notFound('Connection not found');
      }
      stored.exposed = exposed
        ? [...new Set([...stored.exposed, collection])]
        : stored.exposed.filter((name) => name !== collection);
      // Either decision counts as "reviewed" and clears the review queue.
      stored.known = [...new Set([...stored.known, collection])];
      stored.updatedAt = new Date().toISOString();
      return structuredClone(stored);
    });
    this.deps.audit.record({
      actor,
      operation: exposed ? 'collection.expose' : 'collection.hide',
      target: `${id}/${collection}`,
    });
    this.deps.events.publish({ type: 'connection.changed', connectionId: id });
    return updated;
  }

  /** Read the database structure again, for example after a migration. */
  async refresh(id: string, actor: string): Promise<StoredConnection> {
    const current = this.require(id);
    const previous = this.live.get(id);
    this.live.delete(id);
    void previous?.then((old) => old.adapter.close()).catch(() => undefined);
    const live = await this.open(id);

    const names = new Set(live.discovered.map((collection) => collection.name));
    const updated = await this.deps.store.update((state) => {
      const stored = state.connections[id];
      if (!stored) {
        throw errors.notFound('Connection not found');
      }
      stored.exposed = stored.exposed.filter((name) => names.has(name));
      stored.known = stored.known.filter((name) => names.has(name));
      return structuredClone(stored);
    });
    this.deps.audit.record({
      actor,
      operation: 'connection.refresh',
      target: `connection:${current.id}`,
    });
    this.deps.events.publish({ type: 'connection.changed', connectionId: id });
    return updated;
  }

  /**
   * Read the structure again on the open connection (for example right after a
   * migration created tables). Unlike refresh(), the connection stays open.
   * New collections stay hidden until an administrator exposes them.
   */
  async rediscover(id: string): Promise<CollectionDefinition[]> {
    const live = await this.open(id);
    live.discovered = await live.adapter.introspect();
    return live.discovered;
  }

  /** Try the saved settings once, without keeping anything open. */
  async test(
    id: string,
  ): Promise<{ ok: boolean; message: string; collections?: number }> {
    const current = this.require(id);
    const kind = this.kind(current.adapterType);
    try {
      const probe = await this.connectNew(
        kind,
        current.config,
        this.credentialsOf(current),
        id,
        current.mode,
        false,
      );
      await probe.adapter.close();
      this.health.set(id, { status: 'healthy', at: new Date().toISOString() });
      return {
        ok: true,
        message: 'Connected',
        collections: probe.discovered.length,
      };
    } catch (error) {
      const message = safeMessage(error);
      this.health.set(id, {
        status: 'error',
        note: message,
        at: new Date().toISOString(),
      });
      return { ok: false, message };
    }
  }

  /** Close every open adapter (shutdown). Errors are ignored. */
  async closeAll(): Promise<void> {
    const all = [...this.live.values()];
    this.live.clear();
    await Promise.allSettled(
      all.map(async (live) => (await live).adapter.close()),
    );
  }

  // ---- Internals ------------------------------------------------------

  /** The discovered collections, opening the connection first if needed. */
  async discovered(id: string): Promise<CollectionDefinition[]> {
    return (await this.open(id)).discovered;
  }

  /**
   * Forget the open adapter for a connection that another gateway changed or
   * removed, so the next request reopens it with the saved settings.
   */
  invalidate(id: string): void {
    const previous = this.live.get(id);
    this.live.delete(id);
    this.health.delete(id);
    void previous?.then((old) => old.adapter.close()).catch(() => undefined);
  }

  /** Is this connection open right now? (Does not open it.) */
  isOpen(id: string): boolean {
    return this.live.has(id);
  }

  // Single-flight open: concurrent callers share one attempt.
  private open(id: string): Promise<Live> {
    const existing = this.live.get(id);
    if (existing) {
      return existing;
    }

    const connection = this.require(id);
    const kind = this.kind(connection.adapterType);
    const opening = this.connectNew(
      kind,
      connection.config,
      this.credentialsOf(connection),
      id,
      connection.mode,
    ).then(
      (live) => {
        this.health.set(id, {
          status: 'healthy',
          at: new Date().toISOString(),
        });
        return live;
      },
      (error: unknown) => {
        // Forget the failure so the next request tries again.
        this.live.delete(id);
        this.health.set(id, {
          status: 'error',
          note: safeMessage(error),
          at: new Date().toISOString(),
        });
        throw error;
      },
    );
    this.live.set(id, opening);
    return opening;
  }

  /**
   * Connect and read the schema without registering the result.
   *
   * Network hosts are vetted first (SSRF defence). Driver errors are
   * replaced with a generic message because they can contain connection
   * strings or passwords.
   */
  private async connectNew(
    kind: AdapterKind,
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
    connectionId: string,
    mode: ConnectionMode,
    seed = true,
  ): Promise<Live> {
    const host = kind.networkHost(config);
    if (host) {
      await this.deps.networkGuard.assertAllowed(host);
    }

    const adapter = kind.create(config);
    try {
      await adapter.connect({
        connectionId,
        config,
        credentials,
        readOnly: mode !== 'read_write',
      });
      if (seed && kind.seed && kind.wantsSeed?.(config)) {
        await seedAdapter(adapter, kind.seed);
      }
      const discovered = await adapter.introspect();
      return { adapter, discovered };
    } catch (error) {
      await adapter.close().catch(() => undefined);
      throw isSethuError(error)
        ? error
        : errors.connectionFailed('Could not connect to the database');
    }
  }

  /** Decrypt stored credentials; the connection id is the cipher context. */
  private credentialsOf(connection: StoredConnection): Record<string, unknown> {
    return connection.credentials
      ? this.deps.vault.decryptJson<Record<string, unknown>>(
          connection.credentials,
          connection.id,
        )
      : {};
  }

  // `hasOwn` stops names like "constructor" resolving to inherited props.
  private kind(adapterType: string): AdapterKind {
    const kind = Object.hasOwn(this.deps.kinds, adapterType)
      ? this.deps.kinds[adapterType]
      : undefined;
    if (!kind) {
      throw errors.validation(
        `Unknown adapter. Available: ${Object.keys(this.deps.kinds).join(', ')}`,
      );
    }
    return kind;
  }
}

// ---------------------------------------------------------------------------

/** Insert demo records into an empty adapter. */
async function seedAdapter(
  adapter: Adapter,
  seed: Record<string, Array<Record<string, unknown>>>,
): Promise<void> {
  const collections = new Map(
    (await adapter.introspect()).map((collection) => [
      collection.name,
      collection,
    ]),
  );
  for (const [name, records] of Object.entries(seed)) {
    const collection = collections.get(name);
    if (!collection) {
      continue;
    }
    for (const record of records) {
      await adapter.create(collection, record);
    }
  }
}

/**
 * Keep only the exposed collections. Links to collections that are hidden are
 * removed, so the content model never points at something editors cannot see.
 */
function exposedSubset(
  all: CollectionDefinition[],
  exposed: Set<string>,
): CollectionDefinition[] {
  return all
    .filter((collection) => exposed.has(collection.name))
    .map((collection) => ({
      ...collection,
      fields: collection.fields.map((field) => {
        if (field.references && !exposed.has(field.references)) {
          const { references: _removed, ...rest } = field;
          return rest;
        }
        return field;
      }),
      relations: collection.relations.filter((relation) =>
        exposed.has(relation.target),
      ),
    }));
}

/** Require 1..max chars of plain text with no control characters. */
function requireText(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw errors.validation(
      `${name} must be 1 to ${max} characters of plain text`,
    );
  }
  return value.trim();
}

/** Parse the mode; unset means read-only. */
function parseMode(value: unknown): ConnectionMode {
  if (value === undefined) {
    return 'read_only';
  } // safe by default
  if (value === 'read_only' || value === 'read_write') {
    return value;
  }
  throw errors.validation('mode must be "read_only" or "read_write"');
}

/**
 * Settings may not carry secrets: they are shown in the admin and written to
 * the audit log.
 */
function cleanConfig(value: unknown): Record<string, unknown> {
  const config = value === undefined ? {} : assertPlainConfig(value);
  for (const key of Object.keys(config)) {
    if (isSensitiveKey(key)) {
      throw errors.validation(`Put "${key}" in credentials, not config`);
    }
  }
  if (JSON.stringify(config).length > 20_000) {
    throw errors.validation('config is too large');
  }
  return config;
}

/** A message that is safe to show to anyone who can see the connection. */
export function safeMessage(error: unknown): string {
  return isSethuError(error) && error.code !== 'INTERNAL'
    ? error.message
    : 'Could not connect to the database';
}

export { isPlainObject };
