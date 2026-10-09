/**
 * Cursor pagination.
 *
 * Cursors wrap the database's resume position in a signed token.
 * Each cursor is tied to a specific query so it cannot be reused
 * with a different query or modified without invalidating the signature.
 */
import { errors } from './errors.js';
import { canonicalJson, isPlainObject } from './util.js';
import type { Query } from './query-ast.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// 256-bit minimum matches the HMAC-SHA-256 output size.
const MIN_SECRET_BYTES = 32;
// Single shared message so callers cannot tell why a cursor failed.
const INVALID = 'Invalid or expired cursor';

/**
 * @param bytes Raw bytes.
 * @returns URL-safe base64 text without padding.
 */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * @param s URL-safe base64 text.
 * @returns The decoded bytes.
 * @throws SethuError VALIDATION_FAILED on invalid characters.
 */
export function fromBase64Url(s: string): Uint8Array {
  // Buffer silently skips bad characters, so check strictly first.
  if (!/^[A-Za-z0-9_-]+$/.test(s)) {
    throw errors.validation(INVALID);
  }

  return new Uint8Array(Buffer.from(s, 'base64url'));
}

// Not extractable: the key can only sign and verify.
async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    secret as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Creates a fingerprint that excludes pagination details. */
export async function queryFingerprint(q: Query): Promise<string> {
  // Page is dropped so every page of one query shares a fingerprint.
  const { page: _page, ...rest } = q;

  const digest = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(canonicalJson(rest)),
  );

  return toBase64Url(new Uint8Array(digest));
}

/** Settings for {@link CursorCodec}. */
export interface CursorCodecOptions {
  /** The first secret signs new cursors; all secrets can verify existing ones. */
  secrets: Uint8Array[];

  /** Cursor lifetime in seconds. Omit to disable expiry. */
  ttlSeconds?: number;

  /** Optional clock function, useful for testing. Returns milliseconds. */
  now?: () => number;
}

/**
 * Cursor payload:
 * v   - token format version
 * q   - fingerprint of the original query
 * k   - database resume position
 * exp - optional expiry time in Unix seconds
 */
interface CursorPayload {
  v: 1;
  q: string;
  k: unknown;
  exp?: number;
}

/**
 * Signs and verifies pagination cursors with HMAC-SHA-256.
 *
 * Secrets can be rotated: new cursors use the first one, old ones keep working
 * while still listed.
 */
export class CursorCodec {
  private readonly secrets: Uint8Array[];
  private readonly ttlSeconds: number | undefined;
  private readonly now: () => number;

  /**
   * @param opts Secrets, optional TTL and optional clock.
   * @throws SethuError INTERNAL for missing/short secrets or a bad TTL.
   */
  constructor(opts: CursorCodecOptions) {
    if (!Array.isArray(opts.secrets) || opts.secrets.length === 0) {
      throw errors.internal('At least one cursor secret is required');
    }

    if (
      opts.secrets.some(
        (secret) =>
          !(secret instanceof Uint8Array) ||
          secret.byteLength < MIN_SECRET_BYTES,
      )
    ) {
      throw errors.internal(
        `Cursor secrets must be at least ${MIN_SECRET_BYTES} bytes`,
      );
    }

    if (
      opts.ttlSeconds !== undefined &&
      (!Number.isSafeInteger(opts.ttlSeconds) || opts.ttlSeconds <= 0)
    ) {
      throw errors.internal('Cursor TTL must be a positive integer');
    }

    // Copy the bytes so later changes by the caller cannot alter our keys.
    this.secrets = opts.secrets.map((secret) => new Uint8Array(secret));
    this.ttlSeconds = opts.ttlSeconds;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Creates a cursor containing the position needed to fetch the next page.
   *
   * @param query The query this cursor belongs to.
   * @param position Database resume position; must be JSON-serializable.
   * @returns A `payload.signature` token.
   * @throws SethuError VALIDATION_FAILED if position cannot be serialized.
   */
  async encode(query: Query, position: unknown): Promise<string> {
    const payload: CursorPayload = {
      v: 1,
      q: await queryFingerprint(query),
      k: position,
    };

    if (this.ttlSeconds !== undefined) {
      payload.exp = Math.floor(this.now() / 1000) + this.ttlSeconds;
    }

    let serialized: string;

    try {
      serialized = JSON.stringify(payload);
    } catch {
      throw errors.validation('Cursor position must be JSON-serializable');
    }

    const payloadPart = toBase64Url(enc.encode(serialized));
    // Always sign with the newest secret.
    const secret = this.secrets[0]!;

    const signature = await crypto.subtle.sign(
      'HMAC',
      await hmacKey(secret),
      enc.encode(payloadPart),
    );

    return `${payloadPart}.${toBase64Url(new Uint8Array(signature))}`;
  }

  /**
   * Verifies a cursor and returns its database resume position.
   * Invalid cursors always produce the same error message.
   *
   * @param query The query being paged; must match the original.
   * @param cursor Token from the client (untrusted).
   * @returns The database resume position.
   * @throws SethuError VALIDATION_FAILED for any invalid cursor.
   */
  async decode(query: Query, cursor: string): Promise<unknown> {
    // Same error everywhere so failures reveal nothing about why.
    const reject = () => errors.validation(INVALID);

    if (typeof cursor !== 'string' || cursor.length === 0) {
      throw reject();
    }

    // Split the token into its payload and signature.
    const parts = cursor.split('.');

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw reject();
    }

    const [payloadPart, signaturePart] = parts as [string, string];

    // Verify the signature against the current and previous secrets.
    let signature: Uint8Array;

    try {
      signature = fromBase64Url(signaturePart);
    } catch {
      throw reject();
    }

    // Verify before parsing: untrusted payload is never decoded unless it was
    // signed by us. subtle.verify compares in constant time.
    const signedBytes = enc.encode(payloadPart);
    let signatureIsValid = false;

    for (const secret of this.secrets) {
      try {
        const key = await hmacKey(secret);

        if (
          await crypto.subtle.verify(
            'HMAC',
            key,
            signature as unknown as ArrayBuffer,
            signedBytes,
          )
        ) {
          signatureIsValid = true;
          break;
        }
      } catch {
        // A failure with one key (e.g. bad key data) must not block the next.
      }
    }

    if (!signatureIsValid) {
      throw reject();
    }

    // Decode and validate the payload.
    let payload: unknown;

    try {
      payload = JSON.parse(dec.decode(fromBase64Url(payloadPart)));
    } catch {
      throw reject();
    }

    if (
      !isPlainObject(payload) ||
      payload['v'] !== 1 ||
      typeof payload['q'] !== 'string' ||
      !Object.prototype.hasOwnProperty.call(payload, 'k')
    ) {
      throw reject();
    }

    // Reject tokens that contain unexpected fields.
    const allowedKeys = ['v', 'q', 'k', 'exp'];

    if (Object.keys(payload).some((key) => !allowedKeys.includes(key))) {
      throw reject();
    }

    // The cursor must belong to the same query.
    if (payload['q'] !== (await queryFingerprint(query))) {
      throw reject();
    }

    // Check the optional expiry timestamp.
    const expiresAt = payload['exp'];

    if (expiresAt !== undefined) {
      const nowSeconds = Math.floor(this.now() / 1000);

      if (
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= nowSeconds
      ) {
        throw reject();
      }
    }

    return payload['k'];
  }
}
