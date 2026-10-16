/**
 * Sign-in with an authenticator app (Google Authenticator and similar).
 *
 *   POST   /v1/admin/people              (admin) add a person; returns the setup
 *                                        key once
 *   GET    /v1/admin/people              (admin) list people
 *   POST   /v1/admin/people/:id/reset    (admin) new setup key; ends their sessions
 *   PATCH  /v1/admin/people/:id          (admin) change role; ends their sessions
 *   DELETE /v1/admin/people/:id          (admin) remove a person; ends their sessions
 *   POST   /v1/auth/totp/login           username + 6-digit code -> session token
 *
 * The secret is stored encrypted. The first correct code both proves the app was
 * set up and signs the person in. A code works once, and five wrong codes in a
 * row lock that person out for 15 minutes. Every failure looks the same, so the
 * response never says whether the username exists.
 */
import { randomUUID } from 'node:crypto';
import { errors, isPlainObject } from '@sethucms/core';
import { requireRole } from '../auth.js';
import {
  newSecret,
  otpauthUri,
  verifyCode,
  codeFor,
} from '../security/totp.js';
import type { Vault } from '../security/vault.js';
import type { Logger } from '../logger.js';
import type { Role, StoredPerson } from '../store/state.js';
import type { Services } from './services.js';

/** How long a signed-in session lasts. */
const SESSION_HOURS = 8;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;
const ROLES: Role[] = ['admin', 'editor', 'viewer'];
const label = (id: string): string => `totp:${id}`;

/** Fixed secret used to spend the same time on an unknown username. */
const DECOY = Buffer.from('sethucms-decoy-secret');

const publicView = (p: StoredPerson) => ({
  id: p.id,
  username: p.username,
  name: p.name,
  role: p.role,
  enabled: p.enabled,
  createdAt: p.createdAt,
});

export function registerPeopleRoutes(
  s: Services,
  deps: { vault: Vault; logger: Logger },
): void {
  const { vault, logger } = deps;

  const parse = (input: unknown): { username: string; name: string; role: Role } => {
    if (!isPlainObject(input)) {
      throw errors.validation('Body must be a JSON object');
    }
    const username = String(input['username'] ?? '').trim().toLowerCase();
    if (!USERNAME.test(username)) {
      throw errors.validation(
        'Username must be 3 to 40 characters: letters, digits, dot, dash or underscore',
      );
    }
    const role = input['role'];
    if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
      throw errors.validation('Role must be admin, editor or viewer');
    }
    const name = String(input['name'] ?? username).trim().slice(0, 80) || username;
    return { username, name, role: role as Role };
  };

  const setup = (person: StoredPerson, secret: string) => ({
    ...publicView(person),
    // Shown once. Type it into the authenticator app ("Enter a setup key") or
    // open the link on the phone.
    secret,
    otpauthUri: otpauthUri(secret, person.username),
  });

  s.router.add({
    method: 'POST',
    pattern: '/v1/admin/people',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const { username, name, role } = parse(await ctx.json());
      const id = `usr_${randomUUID().slice(0, 8)}`;
      const secret = newSecret();
      const person: StoredPerson = {
        id,
        username,
        name,
        role,
        secret: vault.encrypt(secret, label(id)),
        enabled: false,
        createdAt: new Date().toISOString(),
        createdBy: ctx.principal.id,
      };
      await s.store.update((state) => {
        if (Object.values(state.people).some((p) => p.username === username)) {
          throw errors.conflict('That username is already taken');
        }
        state.people[id] = person;
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'person.create',
        target: `person:${id}`,
        requestId: ctx.requestId,
        detail: { username, role },
      });
      return { status: 201, body: { data: setup(person, secret) } };
    },
  });

  s.router.add({
    method: 'GET',
    pattern: '/v1/admin/people',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 200,
        body: { data: Object.values(s.store.read().people).map(publicView) },
      };
    },
  });

  // True when another person, besides `id`, is an admin.
  const otherAdmin = (people: Record<string, { role: Role }>, id: string) =>
    Object.entries(people).some(([key, p]) => key !== id && p.role === 'admin');

  // Sessions made for a person end when they are reset or removed.
  const endSessions = (personId: string, now: string) =>
    s.store.update((state) => {
      for (const token of Object.values(state.tokens)) {
        if (token.source === 'totp' && token.subject === personId && !token.revokedAt) {
          token.revokedAt = now;
        }
      }
    });

  s.router.add({
    method: 'POST',
    pattern: '/v1/admin/people/:personId/reset',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['personId'] as string;
      const secret = newSecret();
      const now = new Date().toISOString();
      const person = await s.store.update((state) => {
        const found = state.people[id];
        if (!found) {
          throw errors.notFound('Person not found');
        }
        found.secret = vault.encrypt(secret, label(id));
        found.enabled = false;
        delete found.lastStep;
        delete found.failures;
        delete found.lockedUntil;
        return structuredClone(found);
      });
      await endSessions(id, now);
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'person.reset',
        target: `person:${id}`,
        requestId: ctx.requestId,
      });
      return { status: 200, body: { data: setup(person, secret) } };
    },
  });

  s.router.add({
    method: 'PATCH',
    pattern: '/v1/admin/people/:personId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['personId'] as string;
      const body = await ctx.json();
      const role = isPlainObject(body) ? body['role'] : undefined;
      if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
        throw errors.validation('role must be admin, editor or viewer');
      }
      const person = await s.store.update((state) => {
        const found = state.people[id];
        if (!found) {
          throw errors.notFound('Person not found');
        }
        if (found.role === 'admin' && role !== 'admin' && !otherAdmin(state.people, id)) {
          throw errors.conflict('This is the last admin. Add another admin first.');
        }
        found.role = role as Role;
        return structuredClone(found);
      });
      await endSessions(id, new Date().toISOString());
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'person.role',
        target: `person:${id}`,
        detail: { role },
        requestId: ctx.requestId,
      });
      return { status: 200, body: { data: publicView(person) } };
    },
  });

  s.router.add({
    method: 'DELETE',
    pattern: '/v1/admin/people/:personId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['personId'] as string;
      await s.store.update((state) => {
        const found = state.people[id];
        if (!found) {
          throw errors.notFound('Person not found');
        }
        if (found.role === 'admin' && !otherAdmin(state.people, id)) {
          throw errors.conflict('This is the last admin. Add another admin first.');
        }
        delete state.people[id];
      });
      await endSessions(id, new Date().toISOString());
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'person.delete',
        target: `person:${id}`,
        requestId: ctx.requestId,
      });
      return { status: 204 };
    },
  });

  // `expensive`: a small per-address budget, so guessing codes is slow even
  // before the per-person lockout.
  s.router.add({
    method: 'POST',
    pattern: '/v1/auth/totp/login',
    auth: 'none',
    expensive: true,
    handler: async (ctx) => {
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Body must be a JSON object');
      }
      const username = String(input['username'] ?? '').trim().toLowerCase().slice(0, 60);
      const code = String(input['code'] ?? '').slice(0, 16);
      const fail = (): never => {
        throw errors.authFailed('Wrong username or code');
      };
      const now = Date.now();
      const person = Object.values(s.store.read().people).find(
        (p) => p.username === username,
      );
      if (!person) {
        // Spend similar time, then give the same answer as a wrong code.
        codeFor(DECOY, 0);
        return fail();
      }
      if (person.lockedUntil && Date.parse(person.lockedUntil) > now) {
        throw errors.rateLimited('Too many wrong codes. Try again later.', {
          retryAfter: Math.ceil((Date.parse(person.lockedUntil) - now) / 1000),
        });
      }

      let secret: string;
      try {
        secret = vault.decrypt(person.secret, label(person.id));
      } catch {
        logger.error({ event: 'totp.secret_unreadable', person: person.id });
        return fail();
      }
      const step = verifyCode(secret, code, now, person.lastStep ?? -1);

      if (step === null) {
        await s.store.update((state) => {
          const p = state.people[person.id];
          if (!p) {
            return;
          }
          p.failures = (p.failures ?? 0) + 1;
          if (p.failures >= MAX_FAILURES) {
            p.lockedUntil = new Date(now + LOCK_MS).toISOString();
            p.failures = 0;
          }
        });
        s.audit.record({
          actor: `person:${person.id}`,
          operation: 'auth.totp.failed',
          target: `person:${person.id}`,
          requestId: ctx.requestId,
        });
        return fail();
      }

      // Re-check inside the update so two gateways cannot accept one code twice.
      const accepted = await s.store.update((state) => {
        const p = state.people[person.id];
        if (p && (p.lastStep ?? -1) < step) {
          p.lastStep = step;
          p.enabled = true;
          delete p.failures;
          delete p.lockedUntil;
          return true;
        }
        return false;
      });
      if (!accepted) {
        return fail();
      }
      const session = await s.auth.createSession(
        person.name,
        person.role,
        person.id,
        SESSION_HOURS,
        'totp',
      );
      s.audit.record({
        actor: session.id,
        operation: 'auth.totp.login',
        target: `person:${person.id}`,
        requestId: ctx.requestId,
        detail: { role: person.role, expiresAt: session.expiresAt },
      });
      return {
        status: 200,
        body: {
          data: {
            token: session.token,
            expiresAt: session.expiresAt,
            name: person.name,
            role: person.role,
          },
        },
      };
    },
  });
}
