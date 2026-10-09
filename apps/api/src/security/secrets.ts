/**
 * The gateway needs three secrets: one to encrypt stored data (vault), one to
 * sign pagination cursors, and one to sign preview links.
 *
 * In production they must be provided through the environment. For local
 * development they are generated once and kept in `<dataDir>/secrets.json`
 * with owner-only permissions, so restarting does not break cursors or lose
 * access to saved connections.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Key material used by the gateway, decoded from base64. */
export interface Secrets {
  /** AES-256 key for the vault (first 32 bytes are used). */
  vaultKey: Buffer;
  /** HMAC key that signs pagination cursors. */
  cursorSecret: Buffer;
  /** HMAC key that signs preview links. */
  previewSecret: Buffer;
}

/** Where {@link loadSecrets} looks for secrets and how strict to be. */
export interface SecretSources {
  env: NodeJS.ProcessEnv;
  /**
   * Where to keep generated development secrets. Undefined = never write to
   * disk (tests).
   */
  dataDir?: string | undefined;
  /** When true, secrets must come from the environment; none are generated. */
  production: boolean;
}

/** Environment variable that holds each secret. */
const NAMES = {
  vaultKey: 'SETHUCMS_VAULT_KEY',
  cursorSecret: 'SETHUCMS_CURSOR_SECRET',
  previewSecret: 'SETHUCMS_PREVIEW_SECRET',
} as const;

/**
 * Decode a base64 secret and reject short ones.
 * @throws Error when fewer than 32 bytes remain after decoding.
 */
function decode(name: string, value: string): Buffer {
  // 32 bytes minimum so a weak, hand-typed value cannot be used as a key.
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length < 32) {
    throw new Error(
      `${name} must be at least 32 bytes, base64 encoded. Create one with: openssl rand -base64 32`,
    );
  }
  return bytes;
}

/**
 * Resolve all gateway secrets.
 * Environment values always win. Missing ones are an error in production;
 * in development they are read from, or generated into, `secrets.json`.
 *
 * @param sources Environment, optional data folder and production flag.
 * @returns The decoded secrets.
 * @throws Error when a value is too short or, in production, missing.
 */
export async function loadSecrets({
  env,
  dataDir,
  production,
}: SecretSources): Promise<Secrets> {
  const result: Partial<Record<keyof Secrets, Buffer>> = {};
  const missing: Array<keyof typeof NAMES> = [];

  for (const key of Object.keys(NAMES) as Array<keyof typeof NAMES>) {
    const value = env[NAMES[key]];
    if (value) {
      result[key] = decode(NAMES[key], value);
    } else {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    // Never auto-generate in production: a gateway that invents its own key
    // would lose access to saved data on restart, and gateways that share
    // state would each invent a different one.
    if (production) {
      throw new Error(
        `Missing secrets (they must come from the environment in production, and whenever gateways share state): ${missing.map((key) => NAMES[key]).join(', ')}`,
      );
    }
    const stored = await readStoredSecrets(dataDir);
    let changed = false;
    for (const key of missing) {
      const existing = stored[key];
      if (existing) {
        result[key] = decode(NAMES[key], existing);
      } else {
        // Generated keys are random 256-bit values, persisted so restarts work.
        stored[key] = randomBytes(32).toString('base64');
        result[key] = Buffer.from(stored[key] as string, 'base64');
        changed = true;
      }
    }
    if (changed && dataDir) {
      await writeStoredSecrets(dataDir, stored);
    }
  }

  const vaultKey = result.vaultKey as Buffer;
  return {
    // An env value may be longer than 32 bytes; AES-256 needs exactly 32.
    vaultKey: vaultKey.subarray(0, 32),
    cursorSecret: result.cursorSecret as Buffer,
    previewSecret: result.previewSecret as Buffer,
  };
}

/**
 * Read the development secrets file; a missing or broken file counts as empty.
 */
async function readStoredSecrets(
  dataDir: string | undefined,
): Promise<Record<string, string>> {
  if (!dataDir) {
    return {};
  }
  try {
    return JSON.parse(
      await readFile(join(dataDir, 'secrets.json'), 'utf8'),
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Save development secrets where only the current user can read them. */
async function writeStoredSecrets(
  dataDir: string,
  secrets: Record<string, string>,
): Promise<void> {
  // 0700 folder and 0600 file: other local users must not read the keys.
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dataDir, 'secrets.json'),
    JSON.stringify(secrets, null, 2),
    { mode: 0o600 },
  );
}
