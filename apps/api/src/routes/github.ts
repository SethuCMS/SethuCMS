/**
 * Sign in with GitHub.
 *
 *   GET /v1/auth/github/login      send the browser to GitHub
 *   GET /v1/auth/github/callback   GitHub sends the browser back here
 *
 * Works like the single sign-on routes (routes/auth.ts): the attempt (state and
 * PKCE verifier) lives in a short-lived encrypted HttpOnly cookie, and the new
 * session token goes back to the admin app in the URL fragment. The admin app
 * handles both in the same way: #sso_token=... on success and
 * #sso_error=denied|failed|expired on failure.
 */
import { errors } from '@sethucms/core';
import type { Services } from './services.js';
import { constantEquals, readCookie } from './auth.js';
import { OidcError, newPkce, randomToken } from '../security/oidc.js';
import type { GithubClient } from '../security/github.js';
import type { Vault } from '../security/vault.js';
import type { Logger } from '../logger.js';

const COOKIE = 'sethucms_github';
const LOGIN_TTL_S = 600;
const LABEL = 'github-login';

interface Pending {
  state: string;
  verifier: string;
  exp: number;
}

export function registerGithubRoutes(
  s: Services,
  deps: { github: GithubClient | undefined; vault: Vault; logger: Logger },
): void {
  const { github, vault, logger } = deps;
  if (!github) {
    return;
  }
  const secure = github.config.redirectUri.startsWith('https://');
  const cookie = (value: string, maxAge: number): string =>
    `${COOKIE}=${value}; Path=/v1/auth/github; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const back = (fragment: string) => ({
    status: 302,
    headers: {
      Location: `${github.config.adminUrl}#${fragment}`,
      'Set-Cookie': cookie('', 0),
    },
  });

  s.router.add({
    method: 'GET',
    pattern: '/v1/auth/github/login',
    auth: 'none',
    expensive: true,
    handler: () => {
      const pkce = newPkce();
      const pending: Pending = {
        state: randomToken(),
        verifier: pkce.verifier,
        exp: Math.floor(Date.now() / 1000) + LOGIN_TTL_S,
      };
      let location: string;
      try {
        location = github.authorizationUrl({
          state: pending.state,
          challenge: pkce.challenge,
        });
      } catch {
        throw errors.connectionFailed('GitHub sign-in is not available right now');
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
    pattern: '/v1/auth/github/callback',
    auth: 'none',
    expensive: true,
    handler: async (ctx) => {
      const query = ctx.url.searchParams;
      const fail = (
        reason: 'denied' | 'failed' | 'expired',
        why: string,
        extra: Record<string, unknown> = {},
      ) => {
        logger.warn({
          event: 'github.failed',
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
        const identity = await github.complete({
          code,
          verifier: pending.verifier,
        });
        const role = github.roleFor(identity);
        if (!role) {
          s.audit.record({
            actor: `github:${identity.id}`,
            operation: 'auth.github.denied',
            target: 'github',
            requestId: ctx.requestId,
            detail: { login: identity.login },
          });
          return fail('denied', 'not on any list', { github: identity.id });
        }
        const session = await s.auth.createSession(
          identity.login,
          role,
          `github:${identity.id}`,
          github.config.sessionHours,
        );
        s.audit.record({
          actor: session.id,
          operation: 'auth.github.login',
          target: `github:${identity.id}`,
          requestId: ctx.requestId,
          detail: { role, login: identity.login, expiresAt: session.expiresAt },
        });
        return back(
          `sso_token=${encodeURIComponent(session.token)}&sso_expires=${encodeURIComponent(session.expiresAt)}`,
        );
      } catch (error) {
        if (error instanceof OidcError) {
          return fail('failed', error.message, { kind: error.reason });
        }
        logger.error({
          event: 'github.unexpected',
          requestId: ctx.requestId,
          message: error instanceof Error ? error.message : 'unknown',
        });
        return back('sso_error=failed');
      }
    },
  });
}
