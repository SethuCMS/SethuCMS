/**
 * Idempotency-Key support for writes.
 *
 * A client that retries a POST after a timeout must not create two records.
 * The first request with a key runs; later requests with the same key (from
 * the same caller, for the same operation) get the saved answer. Reusing a key
 * for a different request is an error, because it is almost certainly a bug.
 */
import { createHash } from 'node:crypto';
import { errors } from '@sethucms/core';

/** The reply stored for an Idempotency-Key and replayed on retries. */
export interface SavedResponse {
  status: number;
  body: unknown;
}

/** One remembered request. */
interface Entry {
  /** Hash of operation and body, used to spot key reuse. */
  fingerprint: string;
  expiresAt: number;
  /** Stored as a promise so concurrent duplicates wait for the first run. */
  result: Promise<SavedResponse>;
}

/** Longest accepted Idempotency-Key. */
const MAX_KEY_LENGTH = 128;

/**
 * In-memory idempotency cache. State is per process: with several
 * gateways, a retry that lands on another one runs again.
 *
 * @param ttlMs How long an answer is kept (default 24 h).
 * @param maxEntries Cap on remembered keys, to bound memory.
 * @param now Clock, replaceable in tests.
 */
export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Run `work` once per (caller, key); replay its answer on retries.
   *
   * @param caller Who is asking; keys from different callers never collide.
   * @param key The Idempotency-Key header value.
   * @param operation Route or action name, part of the request fingerprint.
   * @param body Request body, part of the fingerprint.
   * @param work Does the real write.
   * @returns The saved response, new or replayed.
   * @throws ValidationError for a malformed key; ConflictError when the key
   * was already used for a different request.
   */
  async run(
    caller: string,
    key: string,
    operation: string,
    body: unknown,
    work: () => Promise<SavedResponse>,
  ): Promise<SavedResponse> {
    if (
      key.length === 0 ||
      key.length > MAX_KEY_LENGTH ||
      !/^[\x21-\x7e]+$/.test(key)
    ) {
      throw errors.validation(
        'Idempotency-Key must be 1 to 128 printable characters',
      );
    }
    this.evictExpired();

    // Scope by caller so one user cannot replay or probe another's keys.
    const id = `${caller}:${key}`;
    const fingerprint = createHash('sha256')
      .update(operation)
      // NUL separator so operation and body cannot blur into each other.
      .update('\0')
      .update(JSON.stringify(body ?? null))
      .digest('hex');

    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw errors.conflict(
          'This Idempotency-Key was already used for a different request',
        );
      }
      return existing.result;
    }

    // Store the promise before awaiting so a duplicate arriving mid-flight
    // shares this run instead of starting a second write.
    const result = work();
    this.entries.set(id, {
      fingerprint,
      expiresAt: this.now() + this.ttlMs,
      result,
    });
    try {
      const saved = await result;
      // Keep successful and client-error answers; let server errors be retried
      // for real.
      if (saved.status >= 500) {
        this.entries.delete(id);
      }
      return saved;
    } catch (error) {
      this.entries.delete(id);
      throw error;
    }
  }

  /**
   * Make room when the cache is full: drop expired entries, then the
   * oldest one if still full.
   */
  private evictExpired(): void {
    if (this.entries.size < this.maxEntries) {
      return;
    }
    const time = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= time) {
        this.entries.delete(id);
      }
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }
}
