/**
 * Time-based one-time passwords (RFC 6238), the 6-digit codes that Google
 * Authenticator, Microsoft Authenticator, 1Password and similar apps show.
 *
 * Standard settings, so every authenticator app works: HMAC-SHA1, 30-second
 * steps, 6 digits, a 160-bit secret shared as base32.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Seconds a code stays the same. */
export const STEP_SECONDS = 30;
const DIGITS = 6;

/** Encode bytes as base32 (RFC 4648, no padding). */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Decode base32; spaces, dashes and case are ignored. Null when invalid. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) {
      return null;
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret, as the base32 text people type into the app. */
export const newSecret = (): string => base32Encode(randomBytes(20));

/** The 6-digit code for one time step. */
export function codeFor(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = (hmac[hmac.length - 1] as number) & 15;
  const binary =
    (((hmac[offset] as number) & 127) << 24) |
    ((hmac[offset + 1] as number) << 16) |
    ((hmac[offset + 2] as number) << 8) |
    (hmac[offset + 3] as number);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The time step a moment falls in. */
export const stepAt = (nowMs: number): number =>
  Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * Check a code. One step either side is accepted to allow for clock drift.
 *
 * @param lastStep The newest step already used by this person. A code from that
 *   step or an older one is refused, so a code seen by someone else cannot be
 *   used a second time.
 * @returns The step the code belongs to, or null when it is wrong or reused.
 */
export function verifyCode(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastStep = -1,
): number | null {
  const secret = base32Decode(secretBase32);
  const wanted = Buffer.from(code.replace(/\s/g, ''));
  if (!secret || !/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    return null;
  }
  const current = stepAt(nowMs);
  let matched: number | null = null;
  // No early exit: every step is compared so timing reveals nothing.
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(codeFor(secret, step));
    if (timingSafeEqual(expected, wanted) && step > lastStep) {
      matched = matched === null ? step : Math.max(matched, step);
    }
  }
  return matched;
}

/** The link an authenticator app understands (also what a QR code holds). */
export function otpauthUri(
  secretBase32: string,
  account: string,
  issuer = 'SethuCMS',
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query}`;
}
