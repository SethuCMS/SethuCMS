/**
 * The vault encrypts secrets (database passwords) and draft contents before
 * they are written to disk.
 *
 * AES-256-GCM gives both secrecy and tamper detection. Each value is bound to
 * a label (for example the connection id), so a ciphertext copied from one
 * record cannot be replayed into another.
 *
 * Format of an encrypted value:  v1.<iv>.<ciphertext>.<tag>   (all base64url)
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { errors } from '@sethucms/core';

/** AES-256 key size. */
const KEY_BYTES = 32;
/** Recommended GCM nonce size. */
const IV_BYTES = 12;

/**
 * Authenticated encryption for values stored at rest.
 * @throws Error from the constructor when the key is not 32 bytes.
 */
export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`The vault key must be exactly ${KEY_BYTES} bytes`);
    }
  }

  /**
   * Encrypt a string.
   * @param plaintext Value to protect.
   * @param label Context (e.g. connection id) bound to the ciphertext.
   * @returns A `v1.<iv>.<ciphertext>.<tag>` string.
   */
  encrypt(plaintext: string, label: string): string {
    // Fresh random IV per message; reusing one with GCM breaks the cipher.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    // Label is authenticated but not stored: decrypting under another label
    // fails, which blocks copying a secret between records.
    cipher.setAAD(Buffer.from(label));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return ['v1', iv, body, tag]
      .map((part) =>
        typeof part === 'string' ? part : part.toString('base64url'),
      )
      .join('.');
  }

  /**
   * Decrypt a value made by {@link Vault.encrypt}.
   * @param value The stored `v1...` string.
   * @param label Must equal the label used when encrypting.
   * @returns The original plaintext.
   * @throws InternalError if the format is unknown or authentication fails.
   */
  decrypt(value: string, label: string): string {
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw errors.internal('Stored secret has an unknown format');
    }
    const [, iv, body, tag] = parts.map((part) =>
      Buffer.from(part as string, 'base64url'),
    ) as [Buffer, Buffer, Buffer, Buffer];
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(label));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      // Wrong key, edited ciphertext or wrong label. Say nothing more.
      throw errors.internal('Stored secret could not be decrypted');
    }
  }

  /** Encrypt any JSON-serialisable value. See {@link Vault.encrypt}. */
  encryptJson(value: unknown, label: string): string {
    return this.encrypt(JSON.stringify(value), label);
  }

  /**
   * Decrypt and parse a value made by `encryptJson`. The caller vouches for
   * the type `T`; nothing validates it here.
   */
  decryptJson<T>(value: string, label: string): T {
    return JSON.parse(this.decrypt(value, label)) as T;
  }
}
