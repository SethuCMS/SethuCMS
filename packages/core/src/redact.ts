/**
 * Removing secrets from anything that gets logged or stored in the audit log.
 * Redaction works on key names (password, token, ...) and on credentials
 * embedded in connection strings.
 */
import { isPlainObject } from './util.js';

/** Placeholder written in place of any removed secret. */
export const REDACTED = '[REDACTED]';

// Matched as lowercase substrings, so `userPassword` and `x-api_key` are caught
// too. Over-redacting is the safe failure mode for logs.
const SENSITIVE_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'authorization',
  'credential',
  'private_key',
  'privatekey',
  'connectionstring',
  'connection_string',
  'cookie',
  'session',
];

/**
 * Check whether a key contains a sensitive fragment.
 */
export function isSensitiveKey(k: string): boolean {
  const l = k.toLowerCase();

  return SENSITIVE_FRAGMENTS.some((f) => l.includes(f));
}

/**
 * Replace credentials embedded in URI-style connection strings.
 */
export function redactConnectionString(s: string): string {
  // First pattern hides the password in `scheme://user:pass@host`. Second hides
  // secret query/option parameters such as `?password=...`.
  return s
    .replace(/(\/\/[^\/:@\s]*:)[^@\/\s]+(@)/g, `$1${REDACTED}$2`)
    .replace(
      /([?&;](?:password|pwd|token|sslkey|sslpassword|accountkey)=)[^&;\s]*/gi,
      `$1${REDACTED}`,
    );
}

/**
 * Deep-copy with sensitive keys and embedded credentials removed.
 * Safe for logs and audit.
 */
export function redact(v: unknown, depth = 0): unknown {
  // Depth cap stops cyclic or hostile deeply nested input from overflowing the
  // stack; anything deeper is redacted rather than risk leaking.
  if (depth > 20) {
    return REDACTED;
  }

  if (typeof v === 'string') {
    return redactConnectionString(v);
  }

  if (Array.isArray(v)) {
    return v.map((x) => redact(x, depth + 1));
  }

  if (isPlainObject(v)) {
    // Null-prototype object so a crafted key cannot touch Object.prototype.
    const out: Record<string, unknown> = Object.create(null);

    for (const [k, x] of Object.entries(v)) {
      // Drop the key entirely instead of copying it (prototype pollution).
      if (k === '__proto__') {
        continue;
      }

      out[k] = isSensitiveKey(k) ? REDACTED : redact(x, depth + 1);
    }

    return out;
  }

  return v;
}

/** Changed fields of a record, split into old and new values. */
export interface RecordDiff {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Redacted before/after values of the fields that changed, for the audit log.
 */
export function diffRecords(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): RecordDiff {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};

  // Union of keys so added and removed fields both show up.
  const keys = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);

  for (const k of keys) {
    const bv = before?.[k];
    const av = after?.[k];

    // Compares by serialized value so unchanged fields (including secrets)
    // never appear in the audit log.
    if (JSON.stringify(bv) === JSON.stringify(av)) {
      continue;
    }

    if (before && k in before) {
      // Sensitive keys are masked even though the value changed: the audit log
      // records that it changed, never what it was.
      b[k] = isSensitiveKey(k) ? REDACTED : redact(bv);
    }

    if (after && k in after) {
      a[k] = isSensitiveKey(k) ? REDACTED : redact(av);
    }
  }

  return { before: b, after: a };
}
