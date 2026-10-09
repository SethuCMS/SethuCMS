/**
 * The canonical type system.
 *
 * Each database has its own native types. Adapters map those types
 * to a shared set of canonical types so the rest of the platform
 * can work with data consistently.
 */

import { isPlainObject } from './util.js';

/** The shared type names every database adapter maps its native types to. */
export const CANONICAL_TYPES = [
  'string',
  'text',
  'integer',
  'decimal',
  'boolean',
  'datetime',
  'date',
  'json',
  'array',
  'reference',
  'binary',
  'geopoint',
] as const;

/** Union of the values in {@link CANONICAL_TYPES}. */
export type CanonicalType = (typeof CANONICAL_TYPES)[number];

/** Comparison operators a query filter may use. */
export const OPERATORS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'nin',
  'contains',
  'startsWith',
  'exists',
] as const;

/** Union of the values in {@link OPERATORS}. */
export type Operator = (typeof OPERATORS)[number];

// Operator sets are layered: equality, then ordering, then text.
const ALL_EQ: Operator[] = ['eq', 'ne', 'in', 'nin', 'exists'];

const ORDERED: Operator[] = [...ALL_EQ, 'lt', 'lte', 'gt', 'gte'];

const TEXTY: Operator[] = [...ORDERED, 'contains', 'startsWith'];

/** Operators allowed for each canonical type. */
export const OPS_BY_TYPE: Readonly<Record<CanonicalType, readonly Operator[]>> =
  {
    string: TEXTY,
    text: TEXTY,
    integer: ORDERED,
    decimal: ORDERED,
    boolean: ['eq', 'ne', 'exists'],
    datetime: ORDERED,
    date: ORDERED,
    json: ['exists'],
    array: ['contains', 'exists'],
    reference: ['eq', 'ne', 'in', 'nin', 'exists'],
    binary: ['exists'],
    geopoint: ['exists'],
  };

/**
 * Types that can be used in a sort. json, array, binary and geopoint have no
 * natural order.
 */
export const SORTABLE_TYPES: ReadonlySet<CanonicalType> = new Set([
  'string',
  'text',
  'integer',
  'decimal',
  'boolean',
  'datetime',
  'date',
  'reference',
]);

/**
 * Checks that a value is plain JSON data.
 *
 * @param v Value to test.
 * @param depth Current nesting level (internal).
 * @returns False for NaN/Infinity, class instances, undefined or very deep
 *   data.
 */
export function isJsonValue(v: unknown, depth = 0): boolean {
  // Depth cap prevents stack exhaustion from hostile nesting.
  if (depth > 32) {
    return false;
  }
  if (v === null) {
    return true;
  }

  switch (typeof v) {
    case 'string':
    case 'boolean':
      return true;

    case 'number':
      // NaN and Infinity are not valid JSON and would break serialization.
      return Number.isFinite(v);

    case 'object':
      if (Array.isArray(v)) {
        return v.every((item) => isJsonValue(item, depth + 1));
      }

      return (
        isPlainObject(v) &&
        Object.values(v).every((item) => isJsonValue(item, depth + 1))
      );

    default:
      return false;
  }
}

// Format checks only. Date.parse is also used below to reject impossible dates.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Checks that a value fits a canonical type.
 *
 * @param type Expected canonical type.
 * @param v Untrusted value.
 * @returns True when the value is acceptable for that type.
 */
export function isValueOfType(type: CanonicalType, v: unknown): boolean {
  switch (type) {
    case 'string':
    case 'text':
      return typeof v === 'string';

    case 'reference':
      // References can use string or integer record keys.
      return (
        typeof v === 'string' ||
        (typeof v === 'number' && Number.isSafeInteger(v))
      );

    // Safe integers only: larger values silently lose precision in JS.
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v);

    // Strings are allowed so callers can send exact decimals without float
    // rounding.
    case 'decimal':
      return (
        (typeof v === 'number' && Number.isFinite(v)) ||
        (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))
      );

    case 'boolean':
      return typeof v === 'boolean';

    case 'datetime':
      return (
        typeof v === 'string' &&
        ISO_DATETIME.test(v) &&
        !Number.isNaN(Date.parse(v))
      );

    case 'date':
      return (
        typeof v === 'string' &&
        ISO_DATE.test(v) &&
        !Number.isNaN(Date.parse(v))
      );

    case 'json':
      return isJsonValue(v);

    case 'array':
      return Array.isArray(v) && isJsonValue(v);

    // Base64 or base64url text; the binary payload itself is never held as
    // bytes here.
    case 'binary':
      return typeof v === 'string' && /^[A-Za-z0-9+/_-]*={0,2}$/.test(v);

    // Exactly lat and lng, no extra keys, within valid ranges.
    case 'geopoint':
      return (
        isPlainObject(v) &&
        Object.keys(v).length === 2 &&
        typeof v['lat'] === 'number' &&
        Number.isFinite(v['lat']) &&
        v['lat'] >= -90 &&
        v['lat'] <= 90 &&
        typeof v['lng'] === 'number' &&
        Number.isFinite(v['lng']) &&
        v['lng'] >= -180 &&
        v['lng'] <= 180
      );
  }
}
