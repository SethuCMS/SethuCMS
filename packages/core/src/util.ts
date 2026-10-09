/**
 * Small helpers shared by every other module.
 *
 * The identifier rules here are a security boundary: collection and field names
 * are only accepted if they look like plain identifiers, so they can never carry
 * SQL fragments or object-prototype tricks.
 */
/** Keys that must never be accepted from untrusted input (prototype pollution). */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/** Conservative identifier shape used for collection and field names. */
export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Checks that a value is a plain, safe identifier for a collection or field
 * name.
 *
 * @param s Untrusted value to test.
 * @returns True (and narrows to string) only for allowed names.
 */
export function isSafeIdentifier(s: unknown): s is string {
  return (
    typeof s === 'string' && IDENTIFIER_RE.test(s) && !FORBIDDEN_KEYS.has(s)
  );
}

/**
 * Checks for a plain `{}`-style object, not an array, class instance or null.
 *
 * @param v Value to test.
 * @returns True when `v` is a plain object (narrows to a record).
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return false;
  }
  // Only Object.prototype or null counts; class instances and exotic objects
  // are rejected so untrusted input has a predictable shape.
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Own-property check that ignores inherited keys such as `toString`.
 *
 * @param o Object to inspect.
 * @param k Property name to look for.
 */
export function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** Keys of `o` that are not in `allowed`. */
export function unknownKeys(
  o: Record<string, unknown>,
  allowed: readonly string[],
): string[] {
  return Object.keys(o).filter((k) => !allowed.includes(k));
}

/**
 * Deterministic JSON with sorted keys, used for hashing and cursor binding.
 *
 * Serializes a value to JSON with keys in sorted order.
 *
 * @param v Any JSON-like value.
 * @returns A stable string: equal data always gives equal output.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    // JSON.stringify returns undefined for undefined/functions; fall back to
    // "null" so the result is always a string.
    return JSON.stringify(v) ?? 'null';
  }
  if (Array.isArray(v)) {
    return '[' + v.map(canonicalJson).join(',') + ']';
  }
  const o = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(o)
      // Sorting keys makes the output independent of insertion order, so
      // fingerprints and hashes stay stable. Undefined values are dropped like
      // JSON.stringify does.
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k]))
      .join(',') +
    '}'
  );
}
