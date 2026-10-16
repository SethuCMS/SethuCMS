/**
 * Sign in and get a workspace.
 *
 *   POST /v1/workspaces/signin   { idToken }
 *     -> { data: { token, expiresAt, name, role, workspace } }
 *
 * `workspace` is null for the people listed in this gateway's own settings
 * (SETHUCMS_FIREBASE_ADMINS and friends): they use the main workspace exactly
 * as before. Everyone else with a verified e-mail gets a workspace of their
 * own and is its admin. The browser then talks to /w/<workspace>/v1/...
 *
 * Teammates are added from inside a workspace (Roles and access, Invite by
 * e-mail) and sign in with POST /w/<workspace>/v1/auth/firebase.
 */
import { randomUUID } from 'node:crypto';
import { errors } from '@sethucms/core';
import type { Services } from './services.js';
import { OidcError } from '../security/oidc.js';
import type { FirebaseVerifier } from '../security/firebase.js';
import type { Logger } from '../logger.js';
import type { Workspaces } from '../tenancy.js';

export function registerWorkspaceRoutes(
  s: Services,
  deps: { firebase: FirebaseVerifier; workspaces: Workspaces; logger: Logger },
): void {
  const { firebase, workspaces, logger } = deps;
  s.router.add({
    method: 'POST',
    pattern: '/v1/workspaces/signin',
    auth: 'none',
    expensive: true,
    handler: async (ctx) => {
      const input = (await ctx.json().catch(() => undefined)) as
        | { idToken?: unknown }
        | undefined;
      const idToken = input?.idToken;
      if (typeof idToken !== 'string' || idToken === '') {
        throw errors.validation('idToken is required');
      }
      const refuse = (why: string, extra: Record<string, unknown> = {}) => {
        logger.warn({ event: 'workspace.signin.failed', requestId: ctx.requestId, why, ...extra });
        return errors.authFailed('Sign-in failed');
      };
      try {
        const identity = await firebase.verify(idToken);
        const name = (identity.email ?? identity.name ?? identity.uid).slice(0, 80);

        // People named in this gateway's settings keep the main workspace.
        const team = firebase.roleFor(identity);
        if (team) {
          const session = await s.auth.createSession(
            name,
            team,
            `firebase:${identity.uid}`,
            firebase.config.sessionHours,
          );
          s.audit.record({
            actor: session.id,
            operation: 'auth.firebase.login',
            target: `firebase:${identity.uid}`,
            requestId: ctx.requestId,
            detail: { role: team, provider: identity.provider },
          });
          return {
            status: 200,
            body: {
              data: { token: session.token, expiresAt: session.expiresAt, name, role: team, workspace: null },
            },
          };
        }

        // A workspace is for a real, verified address only: otherwise anyone
        // could open workspaces under other people's e-mail names.
        const email = identity.email?.toLowerCase();
        if (!email || !identity.emailVerified) {
          throw refuse('e-mail not verified', { uid: identity.uid });
        }
        const { allowedDomains } = firebase.config;
        if (allowedDomains.length > 0 && !allowedDomains.includes(email.split('@')[1] ?? '')) {
          throw refuse('domain not allowed', { uid: identity.uid });
        }

        const id = workspaces.idFor(identity.uid);
        const workspace = await workspaces.get(id);
        const own = workspace.services;
        // The owner is always an admin of their own workspace. This is kept as
        // an invitation so the existing sign-in route accepts them later too.
        await own.store.update((state) => {
          const existing = Object.values(state.invites).find((item) => item.email === email);
          if (existing) {
            existing.role = 'admin';
          } else {
            const inviteId = `inv_${randomUUID().slice(0, 8)}`;
            state.invites[inviteId] = {
              id: inviteId,
              email,
              role: 'admin',
              createdAt: new Date().toISOString(),
              createdBy: 'owner',
            };
          }
        });
        const session = await own.auth.createSession(
          email,
          'admin',
          `firebase:${identity.uid}`,
          firebase.config.sessionHours,
        );
        own.audit.record({
          actor: session.id,
          operation: 'auth.firebase.login',
          target: `firebase:${identity.uid}`,
          requestId: ctx.requestId,
          detail: { role: 'admin', provider: identity.provider, owner: true },
        });
        await workspace.flush().catch(() => undefined);
        return {
          status: 200,
          body: {
            data: {
              token: session.token,
              expiresAt: session.expiresAt,
              name: email,
              role: 'admin',
              workspace: id,
            },
          },
        };
      } catch (error) {
        if (error instanceof OidcError) {
          throw refuse(error.message, { kind: error.reason });
        }
        throw error;
      }
    },
  });
}
