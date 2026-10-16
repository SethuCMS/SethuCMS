/**
 * Sign in with GitHub (OAuth 2.0 authorization code flow with PKCE).
 *
 * GitHub is not an OpenID Connect provider: it sends no ID token to verify. So
 * the proof of identity here is different. We exchange the one-time code for an
 * access token over TLS, ask GitHub "who is this token?" (GET /user), and
 * trust the numeric account id in the answer. The token is then revoked; we
 * never store it.
 *
 * Who may sign in is decided by lists in the gateway's settings, by GitHub user
 * name or, better, by the numeric id ("id:583231"). A user name can be renamed
 * and later taken by someone else; the id never changes.
 *
 * The routes that start and finish a sign-in are in routes/github.ts.
 */
import { fetchJson, fetchLimited, OidcError, assertSecureUrl } from './oidc.js';

/** GitHub sign-in settings. Built from environment variables in config.ts. */
export interface GithubConfig {
  /** Client id of the OAuth app registered on GitHub. */
  clientId: string;
  clientSecret: string;
  /** Must match the "Authorization callback URL" of the OAuth app. */
  redirectUri: string;
  /**
   * Who gets which role: GitHub user names (any case) or "id:<number>".
   * Nobody gets a role by default; anyone not listed is refused.
   */
  roles: { admin: string[]; editor: string[]; viewer: string[] };
  /** Lifetime of the gateway session created after sign-in. */
  sessionHours: number;
  /** Where the browser goes after sign-in (the admin app). */
  adminUrl: string;
  /** GitHub's web address. Change only for GitHub Enterprise Server. */
  webUrl: string;
  /** GitHub's API address. Change only for GitHub Enterprise Server. */
  apiUrl: string;
}

/** Who GitHub says the signed-in person is. */
export interface GithubIdentity {
  /** Numeric account id, as text. The identity to trust. */
  id: string;
  login: string;
  name?: string;
}

const USER_AGENT = 'SethuCMS-gateway';

/** Join a base address and a path, keeping any path in the base (GitHub Enterprise uses /api/v3). */
const join = (base: string, path: string): string =>
  `${base.replace(/\/+$/, '')}${path}`;

/** Talks to GitHub: the sign-in address, the code exchange and the role. */
export class GithubClient {
  constructor(readonly config: GithubConfig) {
    assertSecureUrl(config.redirectUri, 'The redirect address');
    assertSecureUrl(config.webUrl, 'The GitHub address');
    assertSecureUrl(config.apiUrl, 'The GitHub API address');
  }

  /**
   * Build the address to send the browser to. `state` guards against forged
   * callbacks; the PKCE challenge binds the code to our verifier. No scope is
   * requested: the public profile (id and user name) is all we need.
   */
  authorizationUrl(input: { state: string; challenge: string }): string {
    const url = new URL(join(this.config.webUrl, '/login/oauth/authorize'));
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    // Offer GitHub's account-creation link only to people who have no account.
    url.searchParams.set('allow_signup', 'false');
    return url.toString();
  }

  /**
   * Finish a sign-in: trade the code for a token, ask GitHub who it belongs to,
   * then revoke the token.
   * @throws OidcError when GitHub refuses the code or sends something odd.
   */
  async complete(input: {
    code: string;
    verifier: string;
  }): Promise<GithubIdentity> {
    const exchange = (await fetchJson(
      join(this.config.webUrl, '/login/oauth/access_token'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code: input.code,
          redirect_uri: this.config.redirectUri,
          code_verifier: input.verifier,
        }).toString(),
      },
    )) as { access_token?: unknown; error?: unknown };
    // GitHub answers a bad code with status 200 and an "error" field.
    const accessToken = exchange.access_token;
    if (
      exchange.error ||
      typeof accessToken !== 'string' ||
      accessToken === ''
    ) {
      throw new OidcError(
        'provider',
        'GitHub did not accept the sign-in code',
      );
    }

    try {
      const me = (await fetchJson(join(this.config.apiUrl, '/user'), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
      })) as { id?: unknown; login?: unknown; name?: unknown };
      if (
        typeof me.id !== 'number' ||
        !Number.isSafeInteger(me.id) ||
        me.id <= 0 ||
        typeof me.login !== 'string' ||
        !/^[A-Za-z0-9-]{1,39}$/.test(me.login)
      ) {
        throw new OidcError('token', 'GitHub sent an unexpected profile');
      }
      return {
        id: String(me.id),
        login: me.login,
        ...(typeof me.name === 'string' && me.name
          ? { name: me.name.slice(0, 80) }
          : {}),
      };
    } finally {
      await this.revoke(accessToken);
    }
  }

  /** Decide the role, or null when this person may not sign in. */
  roleFor(identity: GithubIdentity): 'admin' | 'editor' | 'viewer' | null {
    const keys = new Set([
      identity.login.toLowerCase(),
      `id:${identity.id}`,
    ]);
    const has = (list: string[]): boolean =>
      list.some((entry) => keys.has(entry.toLowerCase()));
    // Highest role first, so someone on several lists gets the most
    // privileged one.
    if (has(this.config.roles.admin)) {
      return 'admin';
    }
    if (has(this.config.roles.editor)) {
      return 'editor';
    }
    if (has(this.config.roles.viewer)) {
      return 'viewer';
    }
    return null;
  }

  /**
   * Ask GitHub to invalidate the token we were just given. Best effort: the
   * token has no scopes, so if this fails nothing is exposed.
   */
  private async revoke(accessToken: string): Promise<void> {
    try {
      const basic = Buffer.from(
        `${this.config.clientId}:${this.config.clientSecret}`,
      ).toString('base64');
      await fetchLimited(
        join(
          this.config.apiUrl,
          `/applications/${encodeURIComponent(this.config.clientId)}/token`,
        ),
        {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${basic}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
          },
          body: JSON.stringify({ access_token: accessToken }),
        },
      );
    } catch {
      // ignore: see above
    }
  }
}
