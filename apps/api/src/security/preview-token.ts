/**
 * Preview links.
 *
 * A preview link lets a website show a draft before it is published, without
 * giving that website an API token. The link is signed, expires, and is tied
 * to one draft and to the person who created it. Whatever that person is
 * allowed to see is all the link can show.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** What a valid preview token proves. */
export interface PreviewClaims {
  /** The one draft this link may show. */
  draftId: string;
  /** The user whose permissions apply when the link is used. */
  principalId: string;
  /** Expiry, Unix seconds. */
  exp: number;
}

/**
 * Signs and checks preview tokens (`payload.signature`, HMAC-SHA256).
 * Tokens are stateless, so they cannot be revoked before they expire; keep
 * the TTL short.
 */
export class PreviewTokens {
  constructor(
    private readonly secret: Buffer,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /**
   * Create a token for a draft and user.
   * @param claims Draft and principal to bind the token to.
   * @param ttlSeconds Lifetime from now.
   * @returns The token and its expiry (Unix seconds).
   */
  sign(
    claims: Omit<PreviewClaims, 'exp'>,
    ttlSeconds: number,
  ): { token: string; expiresAt: number } {
    const exp = this.now() + ttlSeconds;
    const payload = Buffer.from(
      JSON.stringify({ v: 1, d: claims.draftId, p: claims.principalId, exp }),
    ).toString('base64url');
    return { token: `${payload}.${this.mac(payload)}`, expiresAt: exp };
  }

  /**
   * Returns the claims, or null when the token is malformed, forged or expired.
   */
  verify(token: string): PreviewClaims | null {
    // Cheap size cap before doing any parsing or hashing.
    if (token.length > 1024) {
      return null;
    }
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) {
      return null;
    }

    // Constant-time compare so response timing cannot be used to guess a
    // valid signature. timingSafeEqual throws on unequal lengths, hence the
    // length check first.
    const expected = Buffer.from(this.mac(payload));
    const actual = Buffer.from(signature);
    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      return null;
    }

    try {
      const body = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as { v: number; d: string; p: string; exp: number };
      if (
        body.v !== 1 ||
        typeof body.d !== 'string' ||
        typeof body.p !== 'string' ||
        typeof body.exp !== 'number'
      ) {
        return null;
      }
      if (body.exp <= this.now()) {
        return null;
      }
      return { draftId: body.d, principalId: body.p, exp: body.exp };
    } catch {
      return null;
    }
  }

  /** HMAC of the payload. */
  private mac(payload: string): string {
    // The "preview." prefix keeps this signature from being valid for any
    // other use of the same kind of key (domain separation).
    return createHmac('sha256', this.secret)
      .update(`preview.${payload}`)
      .digest('base64url');
  }
}
