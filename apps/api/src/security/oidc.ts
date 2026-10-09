/**
 * Single sign-on with OpenID Connect (authorization code flow with PKCE).
 *
 * This file is the protocol: discovery, the code exchange and checking the ID
 * token. It uses only node:crypto and fetch, no extra packages. The routes that
 * start and finish a sign-in are in routes/auth.ts.
 *
 * What is checked on every ID token: signature (RS256, PS256 or ES256, with a
 * key from the provider's JWKS), issuer, audience (and authorized party when
 * there are several audiences), expiry, issued-at, and the nonce we sent.
 * The "none" algorithm and symmetric algorithms are never accepted.
 */
import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

/** Single sign-on settings. Built from environment variables in config.ts. */
export interface OidcConfig {
  /** Identity provider base address; must match what its metadata reports. */
  issuer: string;
  /** Application id registered with the provider. */
  clientId: string;
  /** Optional: public clients rely on PKCE alone. */
  clientSecret?: string;
  /**
   * Where the provider sends the browser back to. Must be registered with the
   * provider.
   */
  redirectUri: string;
  /** Space-separated scopes; must include "openid". */
  scopes: string;
  /** Claim that holds the user's groups or roles. */
  roleClaim: string;
  /** Claim values that map to each role. Highest matching role wins. */
  roles: { admin: string[]; editor: string[]; viewer: string[] };
  /**
   * Role given to a signed-in user who matches none of the lists. Undefined
   * means "refuse".
   */
  defaultRole?: 'admin' | 'editor' | 'viewer';
  /** Only these email domains may sign in (empty = any). */
  allowedDomains: string[];
  /** Lifetime of the gateway session created after sign-in. */
  sessionHours: number;
  /** Where the browser goes after sign-in (the admin app). */
  adminUrl: string;
}

/** The parts of the provider's metadata document that we use. */
export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

/** Claims inside a verified ID token (plus any extras the provider adds). */
export interface IdClaims {
  iss: string;
  /** Stable unique id of the person at the provider; the identity to trust. */
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [claim: string]: unknown;
}

/**
 * A sign-in failure. `reason` is a short machine code (config, provider,
 * token); `message` is safe to show the user.
 */
export class OidcError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Give up on provider requests after 10 s. */
const TIMEOUT_MS = 10_000;
/** Largest provider response we will read (1 MB). */
const MAX_BYTES = 1_000_000;
/** Tolerance for clock differences between us and the provider. */
const CLOCK_SKEW_S = 120;

/** True for addresses that point at this machine. */
const isLoopback = (url: URL): boolean =>
  ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);

/**
 * Provider addresses must be https. Plain http is allowed only for a provider
 * on this machine (development).
 */
export function assertSecureUrl(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcError('config', `${what} is not a valid address`);
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopback(url))
  ) {
    throw new OidcError('config', `${what} must use https`);
  }
  return url;
}

/**
 * GET/POST with a timeout, a size cap and no redirects.
 * Redirects are refused so a provider (or attacker) cannot bounce us to an
 * internal address, and the cap stops memory exhaustion.
 */
async function fetchLimited(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new OidcError(
          'provider',
          'The identity provider sent too much data',
        );
      }
      chunks.push(value);
    }
  }
  return {
    status: response.status,
    text: Buffer.concat(chunks).toString('utf8'),
  };
}

/** Fetch and parse JSON, turning any failure into an OidcError. */
async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const { status, text } = await fetchLimited(url, init);
  if (status < 200 || status >= 300) {
    throw new OidcError('provider', `The identity provider answered ${status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new OidcError(
      'provider',
      'The identity provider sent something that is not JSON',
    );
  }
}

/** Base64url without padding, as PKCE and JWTs require. */
const b64url = (buffer: Buffer): string => buffer.toString('base64url');

/**
 * Make a PKCE pair. The verifier stays on the server; only its SHA-256
 * `challenge` goes to the provider, so a stolen authorization code is useless
 * without the verifier.
 */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return {
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
  };
}

/** Random URL-safe string for `state` and `nonce` values. */
export const randomToken = (bytes = 24): string => b64url(randomBytes(bytes));

/**
 * Talks to one identity provider: discovery, code exchange, ID token
 * validation and role mapping.
 */
export class OidcClient {
  // Caches below avoid fetching metadata and keys on every sign-in.
  private discovery: { value: Discovery; at: number } | undefined;
  private keys = new Map<string, KeyObject>();
  private keysAt = 0;
  private lastRefetch = 0;

  constructor(
    readonly config: OidcConfig,
    private readonly now: () => number = Date.now,
  ) {
    assertSecureUrl(config.issuer, 'The OIDC issuer');
    assertSecureUrl(config.redirectUri, 'The redirect address');
    if (!config.scopes.split(/\s+/).includes('openid')) {
      throw new OidcError(
        'config',
        'SETHUCMS_OIDC_SCOPES must include "openid"',
      );
    }
  }

  /**
   * Provider metadata, cached for an hour.
   * @throws OidcError when the provider reports another issuer or lacks a
   * required endpoint.
   */
  async metadata(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.at < 3_600_000) {
      return this.discovery.value;
    }
    const issuer = this.config.issuer.replace(/\/+$/, '');
    const found = (await fetchJson(
      `${issuer}/.well-known/openid-configuration`,
    )) as Partial<Discovery>;
    // The issuer must match exactly what we configured; otherwise a
    // different provider's metadata could be substituted (mix-up attack).
    if (found.issuer?.replace(/\/+$/, '') !== issuer) {
      throw new OidcError(
        'provider',
        'The provider reports a different issuer than the one configured',
      );
    }
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
    ] as const) {
      if (!found[field]) {
        throw new OidcError(
          'provider',
          `The provider's configuration has no ${field}`,
        );
      }
      // Every endpoint the provider names must also be https.
      assertSecureUrl(found[field] as string, field);
    }
    if (found.userinfo_endpoint) {
      assertSecureUrl(found.userinfo_endpoint, 'userinfo_endpoint');
    }
    this.discovery = { value: found as Discovery, at: this.now() };
    return found as Discovery;
  }

  /** The address to send the browser to. */
  /**
   * Build the address to send the browser to.
   * `state` guards against forged callbacks, `nonce` ties the ID token to this
   * sign-in, and the PKCE challenge binds the code to our verifier.
   */
  async authorizationUrl(input: {
    state: string;
    nonce: string;
    challenge: string;
  }): Promise<string> {
    const meta = await this.metadata();
    const url = new URL(meta.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scopes);
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /**
   * Trade the code for tokens, check the ID token and return its claims (plus
   * userinfo when the role claim is missing).
   */
  /**
   * Finish a sign-in: exchange the code, validate the ID token, find roles.
   * @param input Authorization `code`, our PKCE `verifier` and the `nonce`.
   * @returns Verified claims and the role values found for the person.
   * @throws OidcError when the exchange or validation fails.
   */
  async complete(input: {
    code: string;
    verifier: string;
    nonce: string;
  }): Promise<{ claims: IdClaims; roleValues: string[] }> {
    const meta = await this.metadata();
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: input.verifier,
    });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (this.config.clientSecret) {
      // Client secret via HTTP Basic, the method every provider supports.
      headers['Authorization'] =
        `Basic ${Buffer.from(`${encodeForm(this.config.clientId)}:${encodeForm(this.config.clientSecret)}`).toString('base64')}`;
    }

    const tokens = (await fetchJson(meta.token_endpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
    })) as { id_token?: string; access_token?: string };
    if (!tokens.id_token) {
      throw new OidcError('provider', 'The provider sent no ID token');
    }

    const claims = await this.verifyIdToken(tokens.id_token, input.nonce);
    let roleValues = valuesOf(claims[this.config.roleClaim]);
    // Some providers keep groups out of the ID token. Ask the userinfo
    // endpoint, and only trust it for the same subject.
    if (
      roleValues.length === 0 &&
      meta.userinfo_endpoint &&
      tokens.access_token
    ) {
      const info = (await fetchJson(meta.userinfo_endpoint, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/json',
        },
      })) as IdClaims;
      // Reject userinfo for a different subject: it could belong to someone
      // else if tokens were mixed up.
      if (info.sub === claims.sub) {
        roleValues = valuesOf(info[this.config.roleClaim]);
      }
    }
    return { claims, roleValues };
  }

  /**
   * Check an ID token from the provider.
   * Signature, issuer, audience, expiry, issue time, subject and nonce are all
   * verified; any failure rejects the sign-in.
   * @param token The compact JWT.
   * @param expectedNonce The nonce we sent for this sign-in.
   * @returns The trusted claims.
   * @throws OidcError describing the first failed check.
   */
  async verifyIdToken(token: string, expectedNonce: string): Promise<IdClaims> {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 16_384) {
      throw new OidcError('token', 'The ID token is malformed');
    }
    let header: { alg?: string; kid?: string };
    let claims: IdClaims;
    try {
      header = JSON.parse(
        Buffer.from(parts[0] as string, 'base64url').toString('utf8'),
      );
      claims = JSON.parse(
        Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
      );
    } catch {
      throw new OidcError('token', 'The ID token is malformed');
    }
    const alg = header.alg ?? '';
    // Allow-list of asymmetric algorithms. Refusing "none" and HMAC blocks
    // forged tokens (e.g. signing with the public key as an HMAC secret).
    if (!['RS256', 'PS256', 'ES256'].includes(alg)) {
      throw new OidcError(
        'token',
        `The ID token uses an algorithm that is not accepted (${alg || 'none'})`,
      );
    }

    // The key comes from the provider's published JWKS, never from the token.
    const key = await this.keyFor(header.kid, alg);
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2] as string, 'base64url');
    const ok =
      alg === 'RS256'
        ? cryptoVerify('RSA-SHA256', data, key, signature)
        : alg === 'PS256'
          ? cryptoVerify(
              'sha256',
              data,
              { key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 32 },
              signature,
            )
          : cryptoVerify(
              'sha256',
              data,
              { key, dsaEncoding: 'ieee-p1363' },
              signature,
            );
    if (!ok) {
      throw new OidcError('token', 'The ID token signature is not valid');
    }

    const nowS = Math.floor(this.now() / 1000);
    if (
      claims.iss?.replace(/\/+$/, '') !== this.config.issuer.replace(/\/+$/, '')
    ) {
      throw new OidcError(
        'token',
        'The ID token comes from a different issuer',
      );
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(this.config.clientId)) {
      throw new OidcError(
        'token',
        'The ID token was not issued for this application',
      );
    }
    // With several audiences the token must say which party it was for (OIDC
    // Core 3.1.3.7).
    if (audiences.length > 1 && claims.azp !== this.config.clientId) {
      throw new OidcError(
        'token',
        'The ID token has several audiences and a different authorized party',
      );
    }
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < nowS) {
      throw new OidcError('token', 'The ID token has expired');
    }
    if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > nowS) {
      throw new OidcError('token', 'The ID token was issued in the future');
    }
    if (
      typeof claims.sub !== 'string' ||
      claims.sub === '' ||
      claims.sub.length > 255
    ) {
      throw new OidcError('token', 'The ID token has no subject');
    }
    // Replay protection: the token must belong to the sign-in we started.
    if (claims.nonce !== expectedNonce) {
      throw new OidcError(
        'token',
        'The ID token nonce does not match this sign-in',
      );
    }
    return claims;
  }

  /** Decide the role, or null when this person may not sign in. */
  roleFor(
    claims: IdClaims,
    roleValues: string[],
  ): 'admin' | 'editor' | 'viewer' | null {
    const { allowedDomains, roles, defaultRole } = this.config;
    if (allowedDomains.length > 0) {
      const email =
        typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
      const domain = email.split('@')[1] ?? '';
      // An unverified address proves nothing, so it cannot satisfy a domain
      // rule.
      if (claims.email_verified !== true || !allowedDomains.includes(domain)) {
        return null;
      }
    }
    const has = (list: string[]): boolean =>
      list.some((value) => roleValues.includes(value));
    // Check highest role first so a user in several groups gets the most
    // privileged match (admin is never a default).
    if (has(roles.admin)) {
      return 'admin';
    }
    if (has(roles.editor)) {
      return 'editor';
    }
    if (has(roles.viewer)) {
      return 'viewer';
    }
    return defaultRole ?? null;
  }

  /**
   * Find the public key for a token, refreshing the key set if needed.
   * @throws OidcError when the key is unknown or does not fit the algorithm.
   */
  private async keyFor(
    kid: string | undefined,
    alg: string,
  ): Promise<KeyObject> {
    const cacheId = kid ?? '';
    const cached = this.keys.get(cacheId);
    if (cached && this.now() - this.keysAt < 3_600_000) {
      return cached;
    }
    // Unknown key id: the provider may have rotated keys. Refetch, but at most
    // once a minute.
    if (this.now() - this.lastRefetch > 60_000 || !cached) {
      this.lastRefetch = this.now();
      await this.loadKeys();
    }
    const key =
      this.keys.get(cacheId) ??
      (kid === undefined && this.keys.size === 1
        ? [...this.keys.values()][0]
        : undefined);
    if (!key) {
      throw new OidcError(
        'token',
        'The ID token was signed with a key the provider does not publish',
      );
    }
    // Stops algorithm confusion: an EC key cannot be used for RSA tokens or
    // the reverse.
    if ((alg === 'ES256') !== (key.asymmetricKeyType === 'ec')) {
      throw new OidcError(
        'token',
        'The ID token algorithm does not match its key',
      );
    }
    return key;
  }

  /** Download and cache the provider's signing keys (JWKS). */
  private async loadKeys(): Promise<void> {
    const meta = await this.metadata();
    const document = (await fetchJson(meta.jwks_uri)) as {
      keys?: Array<JsonWebKey & { kid?: string; use?: string }>;
    };
    const next = new Map<string, KeyObject>();
    for (const jwk of document.keys ?? []) {
      // Skip keys meant for encryption.
      if (jwk.use && jwk.use !== 'sig') {
        continue;
      }
      if (jwk.kty !== 'RSA' && jwk.kty !== 'EC') {
        continue;
      }
      try {
        next.set(jwk.kid ?? '', createPublicKey({ key: jwk, format: 'jwk' }));
      } catch {
        // skip a key we cannot read
      }
    }
    this.keys = next;
    this.keysAt = this.now();
  }
}

/** Normalise a claim (string or list of strings) to a list of strings. */
function valuesOf(claim: unknown): string[] {
  if (typeof claim === 'string') {
    return [claim];
  }
  if (Array.isArray(claim)) {
    return claim.filter((value): value is string => typeof value === 'string');
  }
  return [];
}

/**
 * application/x-www-form-urlencoded escaping, as client authentication
 * requires.
 */
const encodeForm = (value: string): string =>
  encodeURIComponent(value).replace(/%20/g, '+');
