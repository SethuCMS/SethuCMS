/**
 * Sign in with a Firebase ID token.
 *
 *   POST /v1/auth/firebase   { idToken } -> { data: { token, expiresAt, name, role } }
 *
 * The admin app gets the ID token from the Firebase web SDK (Google or GitHub
 * popup). Unlike the redirect-based sign-ins, no browser cookie is involved:
 * the token itself is the proof, and it must be fresh (see security/firebase.ts).
 */
import { errors } from '@sethucms/core';
import type { Services } from './services.js';
import { OidcError } from '../security/oidc.js';
import type { FirebaseVerifier } from '../security/firebase.js';
import type { Logger } from '../logger.js';
import type { Role } from '../store/state.js';

export function registerFirebaseRoutes(
  s: Services,
  deps: { firebase: FirebaseVerifier | undefined; logger: Logger },
): void {
  const { firebase, logger } = deps;
  if (!firebase) {
    return;
  }
  const invitedRole = (identity: {
    email?: string | undefined;
    emailVerified: boolean;
  }): Role | null => {
    // Same rule as the lists: an address counts only when it is verified, and
    // the optional domain allow-list still applies.
    if (!identity.email || !identity.emailVerified) {
      return null;
    }
    const { allowedDomains } = firebase.config;
    const domain = identity.email.split('@')[1] ?? '';
    if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) {
      return null;
    }
    const invite = Object.values(s.store.read().invites).find(
      (item) => item.email === identity.email,
    );
    return invite?.role ?? null;
  };
  s.router.add({
    method: 'POST',
    pattern: '/v1/auth/firebase',
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
        logger.warn({ event: 'firebase.failed', requestId: ctx.requestId, why, ...extra });
        // One answer for every failure, so the response says nothing about
        // which check failed.
        return errors.authFailed('Sign-in failed');
      };
      try {
        const identity = await firebase.verify(idToken);
        // The environment lists win; otherwise an invitation added in the
        // admin panel can let a verified address in.
        const role = firebase.roleFor(identity) ?? invitedRole(identity);
        if (!role) {
          s.audit.record({
            actor: `firebase:${identity.uid}`,
            operation: 'auth.firebase.denied',
            target: 'firebase',
            requestId: ctx.requestId,
          });
          throw refuse('not on any list', { uid: identity.uid });
        }
        const name = (identity.email ?? identity.name ?? identity.uid).slice(0, 80);
        const session = await s.auth.createSession(
          name,
          role,
          `firebase:${identity.uid}`,
          firebase.config.sessionHours,
        );
        s.audit.record({
          actor: session.id,
          operation: 'auth.firebase.login',
          target: `firebase:${identity.uid}`,
          requestId: ctx.requestId,
          detail: { role, provider: identity.provider, expiresAt: session.expiresAt },
        });
        return {
          status: 200,
          body: { data: { token: session.token, expiresAt: session.expiresAt, name, role } },
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
