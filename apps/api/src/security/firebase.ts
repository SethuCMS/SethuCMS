/**
 * Sign in through Firebase Authentication.
 *
 * The admin app signs the person in with the Firebase web SDK (Google or
 * GitHub popup) and sends us the Firebase ID token. This file checks that
 * token. Firebase ID tokens are RS256 JWTs signed by Google; the keys are
 * published as a JWKS.
 *
 * Checked on every token: signature, issuer (https://securetoken.google.com/
 * <project>), audience (the project id), expiry, issue time, a recent sign-in
 * (so an old, leaked token is useless), and the sign-in provider. Only the
 * providers we list may be used: this keeps out "anonymous" and "password"
 * accounts that anyone could create in the project.
 *
 * The route that receives the token is in routes/firebase.ts.
 */
import {
  createPublicKey,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { OidcError, assertSecureUrl, fetchJson } from './oidc.js';

/** Firebase sign-in settings. Built from environment variables in config.ts. */
export interface FirebaseAuthConfig {
  /** Firebase project id (the token audience). */
  projectId: string;
  /** Public web settings the admin app needs to open the sign-in popup. */
  web: { apiKey: string; authDomain: string };
  /**
   * Who gets which role: e-mail addresses (only when Firebase reports them as
   * verified) or "uid:<firebase uid>". Nobody else may sign in.
   */
  roles: { admin: string[]; editor: string[]; viewer: string[] };
  /** Only these e-mail domains may sign in (empty = any listed person). */
  allowedDomains: string[];
  /** Accepted sign-in providers, e.g. "google.com", "github.com". */
  providers: string[];
  sessionHours: number;
  /** Where Firebase publishes its signing keys (JWK format). */
  jwksUrl: string;
}

/** What we keep from a verified Firebase ID token. */
export interface FirebaseIdentity {
  uid: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  provider: string;
}

export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const CLOCK_SKEW_S = 120;
/** The person must have signed in within this many seconds. */
const MAX_SIGN_IN_AGE_S = 600;

export class FirebaseVerifier {
  private keys = new Map<string, KeyObject>();
  private keysAt = 0;
  private lastRefetch = 0;

  constructor(
    readonly config: FirebaseAuthConfig,
    private readonly now: () => number = Date.now,
  ) {
    assertSecureUrl(config.jwksUrl, 'The Firebase key address');
    if (!/^[a-z0-9-]{4,64}$/.test(config.projectId)) {
      throw new OidcError('config', 'The Firebase project id looks wrong');
    }
  }

  /**
   * Check a Firebase ID token.
   * @throws OidcError describing the first failed check.
   */
  async verify(token: string): Promise<FirebaseIdentity> {
    const parts = token.split('.');
    if (parts.length !== 3 || token.length > 16_384) {
      throw new OidcError('token', 'The token is malformed');
    }
    let header: { alg?: string; kid?: string };
    let claims: Record<string, any>;
    try {
      header = JSON.parse(
        Buffer.from(parts[0] as string, 'base64url').toString('utf8'),
      );
      claims = JSON.parse(
        Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
      );
    } catch {
      throw new OidcError('token', 'The token is malformed');
    }
    // Firebase signs with RS256 only. Refusing everything else blocks "none"
    // and key-confusion tricks.
    if (header.alg !== 'RS256' || !header.kid) {
      throw new OidcError('token', 'The token uses an algorithm that is not accepted');
    }
    const key = await this.keyFor(header.kid);
    const ok = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      key,
      Buffer.from(parts[2] as string, 'base64url'),
    );
    if (!ok) {
      throw new OidcError('token', 'The token signature is not valid');
    }

    const { projectId } = this.config;
    const nowS = Math.floor(this.now() / 1000);
    if (claims['iss'] !== `https://securetoken.google.com/${projectId}`) {
      throw new OidcError('token', 'The token comes from a different issuer');
    }
    if (claims['aud'] !== projectId) {
      throw new OidcError('token', 'The token was not issued for this project');
    }
    if (typeof claims['exp'] !== 'number' || claims['exp'] + CLOCK_SKEW_S < nowS) {
      throw new OidcError('token', 'The token has expired');
    }
    if (typeof claims['iat'] !== 'number' || claims['iat'] - CLOCK_SKEW_S > nowS) {
      throw new OidcError('token', 'The token was issued in the future');
    }
    const authTime = claims['auth_time'];
    if (
      typeof authTime !== 'number' ||
      authTime - CLOCK_SKEW_S > nowS ||
      nowS - authTime > MAX_SIGN_IN_AGE_S
    ) {
      throw new OidcError('token', 'The sign-in is too old; sign in again');
    }
    const uid = claims['sub'];
    if (typeof uid !== 'string' || uid === '' || uid.length > 128) {
      throw new OidcError('token', 'The token has no user id');
    }
    const provider = claims['firebase']?.sign_in_provider;
    if (typeof provider !== 'string' || !this.config.providers.includes(provider)) {
      throw new OidcError('token', 'That sign-in method is not allowed');
    }
    return {
      uid,
      emailVerified: claims['email_verified'] === true,
      provider,
      ...(typeof claims['email'] === 'string'
        ? { email: claims['email'].toLowerCase().slice(0, 200) }
        : {}),
      ...(typeof claims['name'] === 'string'
        ? { name: claims['name'].slice(0, 80) }
        : {}),
    };
  }

  /** Decide the role, or null when this person may not sign in. */
  roleFor(identity: FirebaseIdentity): 'admin' | 'editor' | 'viewer' | null {
    const { allowedDomains, roles } = this.config;
    const keys = new Set<string>([`uid:${identity.uid}`]);
    // An address counts only when Firebase says it is verified; otherwise
    // someone could type another person's address into an account they own.
    if (identity.email && identity.emailVerified) {
      keys.add(identity.email);
      if (allowedDomains.length > 0) {
        const domain = identity.email.split('@')[1] ?? '';
        if (!allowedDomains.includes(domain)) {
          return null;
        }
      }
    } else if (allowedDomains.length > 0) {
      return null;
    }
    const has = (list: string[]): boolean =>
      list.some((entry) => keys.has(entry.toLowerCase()));
    if (has(roles.admin)) {
      return 'admin';
    }
    if (has(roles.editor)) {
      return 'editor';
    }
    if (has(roles.viewer)) {
      return 'viewer';
    }
    return null;
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const cached = this.keys.get(kid);
    if (cached && this.now() - this.keysAt < 3_600_000) {
      return cached;
    }
    // Unknown key: Google may have rotated keys. Refetch, at most once a minute.
    if (!cached && this.now() - this.lastRefetch > 60_000) {
      this.lastRefetch = this.now();
      await this.load();
    } else if (cached) {
      this.lastRefetch = this.now();
      await this.load();
    }
    const key = this.keys.get(kid);
    if (!key) {
      throw new OidcError('token', 'The token was signed with an unknown key');
    }
    return key;
  }

  private async load(): Promise<void> {
    const document = (await fetchJson(this.config.jwksUrl)) as {
      keys?: Array<Record<string, unknown>>;
    };
    const next = new Map<string, KeyObject>();
    for (const jwk of document.keys ?? []) {
      if (jwk['kty'] !== 'RSA' || typeof jwk['kid'] !== 'string') {
        continue;
      }
      try {
        next.set(
          jwk['kid'],
          createPublicKey({ key: jwk as never, format: 'jwk' }),
        );
      } catch {
        // skip a key we cannot read
      }
    }
    this.keys = next;
    this.keysAt = this.now();
  }
}
