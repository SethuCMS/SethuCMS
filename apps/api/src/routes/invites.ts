/**
 * E-mail invitations for Google and GitHub sign-in.
 *
 *   GET    /v1/admin/invites       (admin) list invitations
 *   POST   /v1/admin/invites       (admin) { email, role } invite an address
 *   DELETE /v1/admin/invites/:id   (admin) remove it and end that person's sessions
 *
 * An invitation lets a person sign in through Firebase (Google or GitHub) as
 * soon as their provider has verified the address. The lists in the gateway's
 * environment still work and take priority. Every invitation, and every
 * removal, is written to the audit log.
 */
import { randomUUID } from 'node:crypto';
import { errors, isPlainObject } from '@sethucms/core';
import { requireRole } from '../auth.js';
import type { Role, StoredInvite } from '../store/state.js';
import type { Services } from './services.js';

const ROLES: Role[] = ['admin', 'editor', 'viewer'];
// Deliberately plain: one "@", no spaces, a dot in the domain.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
/** Plenty for a team; stops a runaway script from filling the state file. */
const MAX_INVITES = 200;

const view = (invite: StoredInvite) => ({
  id: invite.id,
  email: invite.email,
  role: invite.role,
  createdAt: invite.createdAt,
});

export function registerInviteRoutes(s: Services): void {
  s.router.add({
    method: 'GET',
    pattern: '/v1/admin/invites',
    auth: 'token',
    handler: (ctx) => {
      requireRole(ctx.principal, 'admin');
      return {
        status: 200,
        body: { data: Object.values(s.store.read().invites).map(view) },
      };
    },
  });

  s.router.add({
    method: 'POST',
    pattern: '/v1/admin/invites',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const input = await ctx.json();
      if (!isPlainObject(input)) {
        throw errors.validation('Body must be a JSON object');
      }
      const email = String(input['email'] ?? '').trim().toLowerCase();
      if (email.length > 200 || !EMAIL.test(email)) {
        throw errors.validation('Enter a valid e-mail address');
      }
      const role = input['role'];
      if (typeof role !== 'string' || !ROLES.includes(role as Role)) {
        throw errors.validation('Role must be admin, editor or viewer');
      }
      const invite: StoredInvite = {
        id: `inv_${randomUUID().slice(0, 8)}`,
        email,
        role: role as Role,
        createdAt: new Date().toISOString(),
        createdBy: ctx.principal.id,
      };
      await s.store.update((state) => {
        if (Object.values(state.invites).some((item) => item.email === email)) {
          throw errors.conflict('That address is already invited');
        }
        if (Object.keys(state.invites).length >= MAX_INVITES) {
          throw errors.conflict('Too many invitations. Remove some first.');
        }
        state.invites[invite.id] = invite;
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'invite.create',
        target: `invite:${invite.id}`,
        requestId: ctx.requestId,
        detail: { email, role },
      });
      return { status: 201, body: { data: view(invite) } };
    },
  });

  s.router.add({
    method: 'DELETE',
    pattern: '/v1/admin/invites/:inviteId',
    auth: 'token',
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const id = ctx.params['inviteId'] as string;
      const now = new Date().toISOString();
      const removed = await s.store.update((state) => {
        const found = state.invites[id];
        if (!found) {
          throw errors.notFound('Invitation not found');
        }
        delete state.invites[id];
        // Sign-in sessions made through Firebase carry the address as their
        // name, so ending them here closes the door at once.
        for (const token of Object.values(state.tokens)) {
          if (
            token.name === found.email &&
            token.subject?.startsWith('firebase:') &&
            !token.revokedAt
          ) {
            token.revokedAt = now;
          }
        }
        return found;
      });
      s.audit.record({
        actor: ctx.principal.id,
        operation: 'invite.delete',
        target: `invite:${id}`,
        requestId: ctx.requestId,
        detail: { email: removed.email },
      });
      return { status: 204 };
    },
  });
}
