/**
 * Who is calling, and what may they do.
 *
 * Callers present an API token in the `Authorization: Bearer` header. Only the
 * SHA-256 hash of a token is stored, so a leaked state file does not leak
 * working tokens. Tokens carry a role:
 *
 *   admin   - everything, including connections, tokens and the audit log
 *   editor  - read, create, update, delete records; work with drafts and
 * publish
 *   viewer  - read published records
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { errors, type Permission } from '@sethucms/core';
import type { Role, StateStore, StoredToken } from './store/state.js';

/** The authenticated caller attached to a request. */
export interface Principal {
  /** Token id (not the secret value). */
  id: string;
  /** Human label of the token, for audit entries. */
  name: string;
  /** Role that decides which actions are allowed. */
  role: Role;
}

/**
 * Record-level permissions per role. Admin and editor differ elsewhere
 * (admin-only routes use {@link requireRole}), not in record actions.
 */
const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    { action: 'read' },
    { action: 'create' },
    { action: 'update' },
    { action: 'delete' },
  ],
  editor: [
    { action: 'read' },
    { action: 'create' },
    { action: 'update' },
    { action: 'delete' },
  ],
  viewer: [{ action: 'read' }],
};

/** Permissions to hand to the core library for this caller. */
export const permissionsFor = (principal: Principal): Permission[] =>
  ROLE_PERMISSIONS[principal.role];

/** True once a token's expiry time has passed. No expiry means never. */
const isExpired = (token: StoredToken, now = Date.now()): boolean =>
  token.expiresAt !== undefined && Date.parse(token.expiresAt) <= now;

/**
 * SHA-256 hex of a token. Fast hashing is fine here: tokens are random
 * 192-bit values, so there is nothing to brute-force like a password.
 */
const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** Cap on live SSO sessions per person; older ones are revoked. */
const MAX_SESSIONS_PER_PERSON = 5;

/**
 * Make a random token with a recognisable `adb_` prefix (helps secret
 * scanners spot leaks).
 * @returns The plain token; show it once, then keep only its hash.
 */
export const newTokenValue = (): string =>
  `adb_${randomBytes(24).toString('base64url')}`;

/** Issues, checks and revokes API tokens held in the state store. */
export class Authenticator {
  constructor(private readonly store: StateStore) {}

  /**
   * Find the caller for an `Authorization` header. Throws AUTH_FAILED when it
   * does not match.
   */
  authenticate(header: string | undefined): Principal {
    // Reject odd shapes before hashing: bounded length and character set.
    const match = /^Bearer ([A-Za-z0-9_\-.]{16,200})$/.exec(header ?? '');
    if (!match) {
      throw errors.authFailed('Missing or malformed API token');
    }

    const wanted = Buffer.from(hashToken(match[1] as string));
    let found: StoredToken | undefined;
    // No early exit on purpose: stopping at the first match would leak
    // which position matched through timing.
    // Compare against every stored hash in constant time so timing reveals
    // nothing.
    for (const token of Object.values(this.store.read().tokens)) {
      const candidate = Buffer.from(token.hash);
      if (
        candidate.length === wanted.length &&
        timingSafeEqual(candidate, wanted) &&
        !token.revokedAt &&
        !isExpired(token)
      ) {
        found = token;
      }
    }
    if (!found) {
      // Same message for unknown, revoked and expired: do not reveal which.
      throw errors.authFailed('Invalid or expired API token');
    }
    return { id: found.id, name: found.name, role: found.role };
  }

  /**
   * Look a caller up by id (used by preview links). Null when the token was
   * revoked.
   */
  find(id: string): Principal | null {
    const token = this.store.read().tokens[id];
    if (!token || token.revokedAt || isExpired(token)) {
      return null;
    }
    return { id: token.id, name: token.name, role: token.role };
  }

  /**
   * Create a token. The plain value is returned once and cannot be recovered
   * later.
   */
  /**
   * Create and store a token.
   * @param name Label shown in the token list and audit log.
   * @param role Role the token carries.
   * @param plain Token value; random by default.
   * @param options `expiresInDays` for a token that stops working on its own.
   * @returns The id, the plain token (only chance to see it) and expiry.
   */
  async create(
    name: string,
    role: Role,
    plain: string = newTokenValue(),
    options: { expiresInDays?: number } = {},
  ): Promise<{ id: string; token: string; expiresAt?: string }> {
    const id = `tok_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const days = options.expiresInDays;
    const expiresAt =
      days === undefined
        ? undefined
        : new Date(now + days * 86_400_000).toISOString();
    await this.store.update((state) => {
      state.tokens[id] = {
        id,
        name,
        role,
        hash: hashToken(plain),
        createdAt: new Date(now).toISOString(),
        ...(expiresAt ? { expiresAt, lifetimeDays: days! } : {}),
      };
    });
    return { id, token: plain, ...(expiresAt ? { expiresAt } : {}) };
  }

  /**
   * A short-lived session for someone who signed in through single sign-on or
   * with an authenticator code (`source`).
   * Sessions of the same person beyond the newest few are revoked, and expired
   * sessions are removed, so sign-ins do not pile up in the saved state.
   */
  async createSession(
    name: string,
    role: Role,
    subject: string,
    hours: number,
    source: 'oidc' | 'totp' = 'oidc',
  ): Promise<{ id: string; token: string; expiresAt: string }> {
    const plain = newTokenValue();
    const id = `tok_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const expiresAt = new Date(now + hours * 3_600_000).toISOString();
    await this.store.update((state) => {
      for (const [key, token] of Object.entries(state.tokens)) {
        if (
          token.source === source &&
          token.expiresAt &&
          Date.parse(token.expiresAt) < now - 86_400_000
        ) {
          delete state.tokens[key];
        }
      }
      const mine = Object.values(state.tokens)
        .filter(
          (token) =>
            token.source === source &&
            token.subject === subject &&
            !token.revokedAt,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const old of mine.slice(MAX_SESSIONS_PER_PERSON - 1)) {
        old.revokedAt = new Date(now).toISOString();
      }
      state.tokens[id] = {
        id,
        name,
        role,
        hash: hashToken(plain),
        createdAt: new Date(now).toISOString(),
        expiresAt,
        source,
        subject,
      };
    });
    return { id, token: plain, expiresAt };
  }

  /**
   * True when the token is a sign-in session (single sign-on or authenticator
   * code) rather than an API token created by an admin.
   */
  isSession(id: string): boolean {
    const source = this.store.read().tokens[id]?.source;
    return source === 'oidc' || source === 'totp';
  }

  /**
   * Replace a token with a new one that has the same name, role and lifetime.
   * The old token keeps working for `graceMinutes` (0 revokes it at once), so a
   * deployment can switch over without downtime.
   */
  async rotate(
    id: string,
    graceMinutes: number,
  ): Promise<{ id: string; token: string; expiresAt?: string }> {
    const old = this.store.read().tokens[id];
    if (!old || old.revokedAt || isExpired(old)) {
      throw errors.notFound('Token not found');
    }
    // Create the replacement first: if this fails, the old token is untouched.
    const created = await this.create(
      old.name,
      old.role,
      newTokenValue(),
      old.lifetimeDays === undefined ? {} : { expiresInDays: old.lifetimeDays },
    );
    await this.store.update((state) => {
      const token = state.tokens[id];
      if (!token) {
        return;
      }
      const now = Date.now();
      // Grace period = shorten the old token's expiry, never extend it, so
      // rotation cannot make a short-lived token live longer.
      if (graceMinutes === 0) {
        token.revokedAt = new Date(now).toISOString();
      } else {
        const endsAt = new Date(now + graceMinutes * 60_000);
        if (
          !token.expiresAt ||
          Date.parse(token.expiresAt) > endsAt.getTime()
        ) {
          token.expiresAt = endsAt.toISOString();
        }
      }
    });
    return created;
  }

  /**
   * Disable a token immediately. Takes effect on the next request (with
   * shared state, after the other gateways' next sync).
   * @throws NotFoundError when the id is unknown.
   */
  async revoke(id: string): Promise<void> {
    await this.store.update((state) => {
      const token = state.tokens[id];
      if (!token) {
        throw errors.notFound('Token not found');
      }
      token.revokedAt = new Date().toISOString();
    });
  }

  /** All tokens for display, with the hash removed. */
  list(): Array<Omit<StoredToken, 'hash'>> {
    return Object.values(this.store.read().tokens).map(
      ({ hash: _hash, ...rest }) => rest,
    );
  }

  /**
   * True if at least one usable admin token exists (used to decide whether
   * first-run setup is still needed).
   */
  hasActiveAdmin(): boolean {
    const state = this.store.read();
    // An admin account (authenticator sign-in) counts too, so the setup token
    // can be retired once a person can sign in.
    return (
      Object.values(state.people).some((person) => person.role === 'admin') ||
      Object.values(state.tokens).some(
        (token) =>
          token.role === 'admin' && !token.revokedAt && !isExpired(token),
      )
    );
  }
}

/**
 * Guard for admin-only or editor-only actions.
 * @throws ForbiddenError when the caller's role is not in `allowed`.
 */
export function requireRole(principal: Principal, ...allowed: Role[]): void {
  if (!allowed.includes(principal.role)) {
    throw errors.forbidden('Your role cannot do this');
  }
}
