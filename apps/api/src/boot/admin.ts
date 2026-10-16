/**
 * First start: make sure someone can sign in.
 */
import { Authenticator } from '../auth.js';

/** Allowed shape for a supplied admin token: long enough to be unguessable. */
const ADMIN_TOKEN_PATTERN = /^[A-Za-z0-9_\-.]{32,200}$/;

/**
 * Make sure someone can sign in on first start.
 * @param auth Token service.
 * @param supplied Admin token from `SETHUCMS_ADMIN_TOKEN`, if any.
 * @param production Refuse to invent credentials when true.
 * @returns A generated token to show once, or undefined if none was made.
 * @throws Error for a malformed supplied token, or in production when no
 * admin exists and none was supplied.
 */
export async function ensureAdmin(
  auth: Authenticator,
  supplied: string | undefined,
  production: boolean,
): Promise<string | undefined> {
  if (supplied) {
    if (!ADMIN_TOKEN_PATTERN.test(supplied)) {
      throw new Error(
        'SETHUCMS_ADMIN_TOKEN must be 32 to 200 characters of A-Z a-z 0-9 _ - .  (create one with: openssl rand -hex 32)',
      );
    }
    try {
      // If this token is not known yet, the catch below registers it. Only the
      // hash is stored, as for every token.
      auth.authenticate(`Bearer ${supplied}`);
    } catch {
      await auth.create('Bootstrap admin', 'admin', supplied);
    }
    return undefined;
  }
  if (auth.hasActiveAdmin()) {
    return undefined;
  }
  if (production) {
    throw new Error(
      'No admin exists. Set SETHUCMS_ADMIN_TOKEN for the first start.',
    );
  }
  // Development convenience only; production must supply its own token.
  return (await auth.create('Local admin', 'admin')).token;
}
