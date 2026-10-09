/**
 * Single sign-on routes.
 *
 *   GET  /v1/auth/config          is single sign-on on? (the admin app asks,
 *                                 to decide whether to show its button)
 *   GET  /v1/auth/oidc/login      send the browser to the identity provider
 *   GET  /v1/auth/oidc/callback   the provider sends the browser back here
 *   POST /v1/auth/logout          end a single sign-on session
 *
 * The login attempt (state, nonce, PKCE verifier) lives in a short-lived,
 * encrypted, HttpOnly cookie rather than on the server, so the callback can
 * land on any gateway when several share state.
 *
 * After a successful sign-in the browser goes to the admin app with the new
 * session token in the URL *fragment* (the part after #), which browsers never
 * send to a server. The admin app moves it into its own storage and clears the
 * address bar at once. A failed sign-in goes to the same place with
 * #sso_error=denied|failed|expired.
 */
import type { IncomingMessage } from 'node:http';
import { errors } from '@sethucms/core';
import type { Services } from './services.js';
import {
  OidcError,
  newPkce,
  randomToken,
  type OidcClient,
} from '../security/oidc.js';
import type { Vault } from '../security/vault.js';
import type { Logger } from '../logger.js';

const COOKIE = 'sethucms_oidc';
const LOGIN_TTL_S = 600;
const LABEL = 'oidc-login';

interface Pending {
  state: string;
  nonce: string;
  verifier: string;
  exp: number;
}

export function registerAuthRoutes(
  s: Services,
  deps: { oidc: OidcClient | undefined; vault: Vault; logger: Logger },
): void {
  const { oidc, vault, logger } = deps;

  s.router.add({
    method: 'GET',
    pattern: '/v1/auth/config',
    auth: 'none',
    handler: () => ({
      status: 200,
      body: {
        oidc: {
          enabled: Boolean(oidc),
          ...(oidc ? { loginPath: '/v1/auth/oidc/login' } : {}),
        },
      },
    }),
  });

  s.router.add({
    method: 'POST',
    pattern: '/v1/auth/logout',
    auth: 'token',
    handler: async (ctx) => {
      // Only single sign-on sessions end here. API tokens are managed (revoked)
      // by an administrator.
      if (s.auth.isSession(ctx.principal.id)) {
        await s.auth.revoke(ctx.principal.id);
        s.audit.record({
          actor: ctx.principal.id,
          operation: 'auth.logout',
          target: `token:${ctx.principal.id}`,
          requestId: ctx.requestId,
        });
      }
      return { status: 204 };
    },
  });

  if (!oidc) {
    return;
  }
  const secure = oidc.config.redirectUri.startsWith('https://');
  const cookie = (value: string, maxAge: number): string =>
    `${COOKIE}=${value}; Path=/v1/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const back = (fragment: string, extra: Record<string, string> = {}) => ({
    status: 302,
    headers: {
      Location: `${oidc.config.adminUrl}#${fragment}`,
      'Set-Cookie': cookie('', 0),
      ...extra,
    },
  });

  s.router.add({
    method: 'GET',
    pattern: '/v1/auth/oidc/login',
    auth: 'none',
    handler: async () => {
      const pkce = newPkce();
      const pending: Pending = {
        state: randomToken(),
        nonce: randomToken(),
        verifier: pkce.verifier,
        exp: Math.floor(Date.now() / 1000) + LOGIN_TTL_S,
      };
      let location: string;
      try {
        location = await oidc.authorizationUrl({
          state: pending.state,
          nonce: pending.nonce,
          challenge: pkce.challenge,
        });
      } catch (error) {
        logger.error({
          event: 'sso.provider_unreachable',
          reason: error instanceof OidcError ? error.reason : 'unknown',
          message: error instanceof Error ? error.message : undefined,
        });
        throw errors.connectionFailed(
          'Single sign-on is not available right now',
        );
      }
      return {
        status: 302,
        headers: {
          Location: location,
          'Set-Cookie': cookie(vault.encryptJson(pending, LABEL), LOGIN_TTL_S),
        },
      };
    },
  });

  s.router.add({
    method: 'GET',
    pattern: '/v1/auth/oidc/callback',
    auth: 'none',
    handler: async (ctx) => {
      const query = ctx.url.searchParams;
      const fail = (
        reason: 'denied' | 'failed' | 'expired',
        why: string,
        extra: Record<string, unknown> = {},
      ) => {
        logger.warn({
          event: 'sso.failed',
          requestId: ctx.requestId,
          reason,
          why,
          ...extra,
        });
        return back(`sso_error=${reason}`);
      };

      let pending: Pending;
      try {
        const raw = readCookie(ctx.req, COOKIE);
        if (!raw) {
          return fail('expired', 'no login cookie');
        }
        pending = vault.decryptJson<Pending>(raw, LABEL);
      } catch {
        return fail('failed', 'login cookie unreadable');
      }
      if (pending.exp < Date.now() / 1000) {
        return fail('expired', 'login took too long');
      }

      const state = query.get('state');
      if (!state || !constantEquals(state, pending.state)) {
        return fail('failed', 'state mismatch');
      }
      if (query.get('error')) {
        return fail(
          query.get('error') === 'access_denied' ? 'denied' : 'failed',
          `provider error: ${(query.get('error') ?? '').slice(0, 60)}`,
        );
      }
      const code = query.get('code');
      if (!code || code.length > 2048) {
        return fail('failed', 'no code');
      }

      try {
        const { claims, roleValues } = await oidc.complete({
          code,
          verifier: pending.verifier,
          nonce: pending.nonce,
        });
        const role = oidc.roleFor(claims, roleValues);
        if (!role) {
          s.audit.record({
            actor: `sso:${claims.sub}`,
            operation: 'auth.sso.denied',
            target: 'sso',
            requestId: ctx.requestId,
          });
          return fail('denied', 'no role for this person', { sub: claims.sub });
        }
        const name = String(claims.email ?? claims.name ?? claims.sub).slice(
          0,
          80,
        );
        const session = await s.auth.createSession(
          name,
          role,
          claims.sub,
          oidc.config.sessionHours,
        );
        s.audit.record({
          actor: session.id,
          operation: 'auth.sso.login',
          target: `sso:${claims.sub}`,
          requestId: ctx.requestId,
          detail: { role, expiresAt: session.expiresAt },
        });
        return back(
          `sso_token=${encodeURIComponent(session.token)}&sso_expires=${encodeURIComponent(session.expiresAt)}`,
        );
      } catch (error) {
        if (error instanceof OidcError) {
          return fail('failed', error.message, { kind: error.reason });
        }
        logger.error({
          event: 'sso.unexpected',
          requestId: ctx.requestId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        return back('sso_error=failed');
      }
    },
  });
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers['cookie'] ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      return rest.join('=');
    }
  }
  return undefined;
}

function constantEquals(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
