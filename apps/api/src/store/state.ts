/**
 * The gateway's own state: saved connections, drafts and API tokens.
 *
 * This is NOT the customer's data. Customer records stay in their databases.
 * This is the small amount of data the CMS itself must remember.
 *
 * State lives in one JSON file, written atomically (write to a temporary file,
 * then rename) with owner-only permissions. That is plenty for a single
 * gateway process. To run several gateways, implement `StateStore` on top of a
 * shared database.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { MigrationJob } from '../migration/manager.js';

/** Whether the gateway may write through a connection. */
export type ConnectionMode = 'read_only' | 'read_write';
/** Permission level of an API token: admin > editor > viewer. */
export type Role = 'admin' | 'editor' | 'viewer';

/** A saved customer database connection. */
export interface StoredConnection {
  id: string;
  name: string;
  adapterType: string;
  mode: ConnectionMode;
  /** Non-secret settings (host, port, database...). */
  config: Record<string, unknown>;
  /** Encrypted credentials, or null when the adapter needs none. */
  credentials: string | null;
  /** Names of the collections editors can see. Everything else stays hidden. */
  exposed: string[];
  /**
   * Collections already seen at least once, so the review queue only shows new
   * ones.
   */
  known: string[];
  createdAt: string;
  updatedAt: string;
}

/** Draft lifecycle. "publishing" marks a write in progress. */
export type DraftStatus = 'draft' | 'publishing' | 'published' | 'discarded';

/** An unpublished change to one record (or a new record). */
export interface StoredDraft {
  id: string;
  connectionId: string;
  collection: string;
  /** The record this draft changes, or null when it creates a new record. */
  recordId: string | null;
  /** Encrypted JSON of the field values. */
  values: string;
  /**
   * Fingerprint of the published record when editing began, to detect changes
   * made meanwhile.
   */
  baseHash: string | null;
  version: number;
  status: DraftStatus;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  publishedRecordId?: string;
}

/**
 * An API token record. Only the hash is kept so a leaked state file does
 * not leak usable tokens.
 */
export interface StoredToken {
  id: string;
  name: string;
  role: Role;
  /** SHA-256 of the token. The token itself is never stored. */
  hash: string;
  createdAt: string;
  revokedAt?: string;
  /**
   * After this moment the token no longer works. Tokens without one never
   * expire.
   */
  expiresAt?: string;
  /** How long a new token made by rotating this one lasts. */
  lifetimeDays?: number;
  /**
   * "oidc" for a session created by single sign-on. Such tokens are short-lived
   * and swept after they expire.
   */
  source?: 'oidc';
  /** The identity provider's id for the person (OIDC `sub`). */
  subject?: string;
}

/** A subscriber that receives change events over HTTP. */
export interface StoredWebhook {
  id: string;
  name: string;
  /** Where events are sent. https only in production. */
  url: string;
  /** Encrypted signing secret. Shown once, when the webhook is created. */
  secret: string;
  /** Event types to send, or ["*"] for all. */
  events: string[];
  /** Only events for this connection / collection, when set. */
  connectionId?: string;
  collection?: string;
  active: boolean;
  createdAt: string;
  createdBy: string;
}

/** Everything the gateway persists, as one JSON document. */
export interface State {
  version: 1;
  connections: Record<string, StoredConnection>;
  drafts: Record<string, StoredDraft>;
  tokens: Record<string, StoredToken>;
  /**
   * Migration history, so it survives a restart. Counts and error codes only,
   * never record values.
   */
  migrations: Record<string, MigrationJob>;
  /** Where change events are delivered. */
  webhooks: Record<string, StoredWebhook>;
}

/** A fresh state with no records. */
export const emptyState = (): State => ({
  version: 1,
  connections: {},
  drafts: {},
  tokens: {},
  migrations: {},
  webhooks: {},
});

/**
 * Where state lives. Implementations must apply `update` calls one at a
 * time so changes never overwrite each other.
 */
export interface StateStore {
  /** The current state. Treat as read-only; change it through `update`. */
  read(): State;
  /**
   * Run `change` on a copy of the state and save the result. Changes are
   * applied one at a time.
   */
  update<T>(change: (state: State) => T): Promise<T>;
}

/** Keeps state in memory only. Used by tests and `--ephemeral` runs. */
export class MemoryStateStore implements StateStore {
  protected state: State = emptyState();

  read(): State {
    return this.state;
  }

  async update<T>(change: (state: State) => T): Promise<T> {
    // Mutate a copy and only swap it in afterwards, so a throwing `change`
    // leaves the real state untouched.
    const draft = structuredClone(this.state);
    const result = change(draft);
    this.state = draft;
    await this.persist(draft);
    return result;
  }

  /** Hook for subclasses to save state; the in-memory store keeps nothing. */
  protected async persist(_state: State): Promise<void> {}
}

/** State kept in `state.json`, safe for one gateway process. */
export class FileStateStore extends MemoryStateStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly path: string) {
    super();
  }

  /**
   * Load `state.json`, or start empty if it does not exist.
   * @throws Error for an unreadable file or an unknown format version.
   */
  static async open(dataDir: string): Promise<FileStateStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const store = new FileStateStore(join(dataDir, 'state.json'));
    try {
      const loaded = JSON.parse(await readFile(store.path, 'utf8')) as State;
      if (loaded.version !== 1) {
        throw new Error('state.json has an unknown version');
      }
      store.state = { ...emptyState(), ...loaded };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return store;
  }

  // Chain updates on a queue so concurrent calls run one at a time.
  override update<T>(change: (state: State) => T): Promise<T> {
    const run = this.queue.then(() => super.update(change));
    this.queue = run.catch(() => undefined);
    return run;
  }

  protected override async persist(state: State): Promise<void> {
    // Write-then-rename: readers and crashes never see a half-written file.
    const temporary = `${this.path}.${randomBytes(4).toString('hex')}.tmp`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
