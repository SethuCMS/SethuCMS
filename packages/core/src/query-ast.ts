/**
 * The portable query format.
 *
 * A Query describes which records a caller wants without depending on a
 * particular database. Adapters translate it into the query language they use.
 *
 * parseQuery validates untrusted input and rejects anything the platform
 * does not recognize.
 */
import { OPERATORS, isJsonValue, type Operator } from './field-types.js';
import { errors, throwIfIssues, type ValidationIssue } from './errors.js';
import {
  FORBIDDEN_KEYS,
  isPlainObject,
  isSafeIdentifier,
  unknownKeys,
} from './util.js';

/** A comparison such as { field: 'age', op: 'gt', value: 18 }. */
export interface Comparison {
  field: string;
  op: Operator;
  value?: unknown;
}

/** All child filters must match. */
export type AndFilter = { and: Filter[] };
/** At least one child filter must match. */
export type OrFilter = { or: Filter[] };
/** Matches when the child filter does not. */
export type NotFilter = { not: Filter };

/** A filter can compare a field or combine other filters. */
export type Filter = Comparison | AndFilter | OrFilter | NotFilter;

/** One sort key and its direction. */
export interface SortSpec {
  field: string;
  dir: 'asc' | 'desc';
}

/** Page size and optional resume cursor. Offset paging is not offered. */
export interface PageSpec {
  limit: number;
  /** Opaque signed token used to fetch the next page. */
  cursor?: string | null;
}

/**
 * A database-independent query. Build it with {@link parseQuery} when the input
 * is untrusted.
 */
export interface Query {
  collection: string;
  filter?: Filter;
  sort?: SortSpec[];
  /** Fields to return. Omitted means all fields the caller may see. */
  projection?: string[];
  page: PageSpec;
}

/** Limits that keep a single query from becoming too expensive. */
export interface QueryLimits {
  defaultLimit: number;
  maxLimit: number;
  maxFilterDepth: number;
  maxFilterNodes: number;
  maxSortFields: number;
  maxInValues: number;
  maxCursorLength: number;
  maxProjectionFields: number;
}

/**
 * Default {@link QueryLimits}. Frozen so they cannot be changed by accident.
 */
export const DEFAULT_QUERY_LIMITS: Readonly<QueryLimits> = Object.freeze({
  defaultLimit: 50,
  maxLimit: 500,
  maxFilterDepth: 8,
  maxFilterNodes: 100,
  maxSortFields: 4,
  maxInValues: 200,
  maxCursorLength: 4096,
  maxProjectionFields: 200,
});

// Helpers for trusted code that builds queries programmatically.
/**
 * Builds an equality comparison. For trusted code only: it does not validate
 * names.
 */
export const eq = (field: string, value: unknown): Comparison => ({
  field,
  op: 'eq',
  value,
});

/** Builds an AND filter from trusted filters. */
export const and = (...filters: Filter[]): AndFilter => ({ and: filters });
/** Builds an OR filter from trusted filters. */
export const or = (...filters: Filter[]): OrFilter => ({ or: filters });
/** Builds a NOT filter from a trusted filter. */
export const not = (filter: Filter): NotFilter => ({ not: filter });

/** Type guard: true for a field comparison, false for and/or/not. */
export function isComparison(filter: Filter): filter is Comparison {
  return 'field' in filter;
}

/** Visit every comparison in a filter tree. */
export function walkFilter(
  filter: Filter,
  visit: (comparison: Comparison) => void,
): void {
  if (isComparison(filter)) {
    visit(filter);
  } else if ('and' in filter) {
    for (const child of filter.and) {
      walkFilter(child, visit);
    }
  } else if ('or' in filter) {
    for (const child of filter.or) {
      walkFilter(child, visit);
    }
  } else {
    walkFilter(filter.not, visit);
  }
}

/** Return each field mentioned in a filter, without duplicates. */
export function collectFilterFields(filter: Filter | undefined): string[] {
  const fields = new Set<string>();

  if (filter) {
    walkFilter(filter, (comparison) => fields.add(comparison.field));
  }

  return [...fields];
}

/**
 * State shared while parsing one query: limits, issues so far and nodes seen.
 */
interface ParseContext {
  limits: QueryLimits;
  issues: ValidationIssue[];
  nodeCount: number;
}

/** True for scalar JSON values. Objects and arrays are not scalars. */
function isScalar(value: unknown): value is string | number | boolean | null {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }

  return typeof value === 'number' && isJsonValue(value);
}

/** Parse one filter node and collect any validation problems. */
function parseFilterNode(
  raw: unknown,
  path: string,
  depth: number,
  ctx: ParseContext,
): Filter | undefined {
  const { limits, issues } = ctx;

  ctx.nodeCount += 1;

  // Cap total nodes so a wide filter cannot be expensive. Report once to avoid
  // a flood of identical issues.
  if (ctx.nodeCount > limits.maxFilterNodes) {
    if (ctx.nodeCount === limits.maxFilterNodes + 1) {
      issues.push({
        path,
        message: `filter has more than ${limits.maxFilterNodes} nodes`,
      });
    }
    return undefined;
  }

  // Cap nesting depth to protect the recursive parser and adapters.
  if (depth > limits.maxFilterDepth) {
    issues.push({
      path,
      message: `filter is nested deeper than ${limits.maxFilterDepth} levels`,
    });
    return undefined;
  }

  if (!isPlainObject(raw)) {
    issues.push({ path, message: 'filter must be an object' });
    return undefined;
  }

  // Reject keys that could be used to manipulate object prototypes.
  // Prototype keys are refused outright rather than ignored.
  const keys = Object.keys(raw);

  for (const key of keys) {
    if (FORBIDDEN_KEYS.has(key)) {
      issues.push({ path: `${path}.${key}`, message: 'forbidden key' });
      return undefined;
    }
  }

  if ('and' in raw) {
    return parseCombinator('and', raw, keys, path, depth, ctx);
  }
  if ('or' in raw) {
    return parseCombinator('or', raw, keys, path, depth, ctx);
  }
  if ('not' in raw) {
    return parseNot(raw, keys, path, depth, ctx);
  }

  return parseComparison(raw, path, ctx);
}

/** Parse an { and: [...] } or { or: [...] } filter. */
function parseCombinator(
  name: 'and' | 'or',
  raw: Record<string, unknown>,
  keys: string[],
  path: string,
  depth: number,
  ctx: ParseContext,
): Filter | undefined {
  // Mixing a combinator with other keys is ambiguous, so it is flagged.
  if (keys.length !== 1) {
    ctx.issues.push({ path, message: `"${name}" must be the only key` });
  }

  const items = raw[name];

  if (!Array.isArray(items) || items.length === 0) {
    ctx.issues.push({
      path: `${path}.${name}`,
      message: 'must be a non-empty array',
    });
    return undefined;
  }

  const children: Filter[] = [];
  let allValid = true;

  items.forEach((item, index) => {
    const child = parseFilterNode(
      item,
      `${path}.${name}[${index}]`,
      depth + 1,
      ctx,
    );

    if (child) {
      children.push(child);
    } else {
      allValid = false;
    }
  });

  if (!allValid) {
    return undefined;
  }

  return name === 'and' ? { and: children } : { or: children };
}

/** Parse a { not: filter } expression. */
function parseNot(
  raw: Record<string, unknown>,
  keys: string[],
  path: string,
  depth: number,
  ctx: ParseContext,
): Filter | undefined {
  if (keys.length !== 1) {
    ctx.issues.push({ path, message: '"not" must be the only key' });
  }

  const child = parseFilterNode(raw['not'], `${path}.not`, depth + 1, ctx);

  return child ? { not: child } : undefined;
}

/** Parse a { field, op, value } comparison. */
function parseComparison(
  raw: Record<string, unknown>,
  path: string,
  ctx: ParseContext,
): Filter | undefined {
  const { issues } = ctx;

  // Unknown keys are errors, not ignored, so typos are caught.
  for (const key of unknownKeys(raw, ['field', 'op', 'value'])) {
    issues.push({ path: `${path}.${key}`, message: 'unknown key' });
  }

  const field = raw['field'];
  const op = raw['op'];
  const value = raw['value'];

  if (!isSafeIdentifier(field)) {
    issues.push({ path: `${path}.field`, message: 'invalid field name' });
    return undefined;
  }

  if (!OPERATORS.includes(op as Operator)) {
    issues.push({ path: `${path}.op`, message: 'unknown operator' });
    return undefined;
  }

  const operator = op as Operator;
  const problem = describeValueProblem(operator, value, ctx.limits);

  if (problem) {
    issues.push({ path: `${path}.value`, message: problem });
  }

  return value === undefined
    ? { field, op: operator }
    : { field, op: operator, value };
}

/** Check that a value is valid for the selected operator. */
function describeValueProblem(
  operator: Operator,
  value: unknown,
  limits: QueryLimits,
): string | undefined {
  switch (operator) {
    case 'exists':
      return value === undefined || typeof value === 'boolean'
        ? undefined
        : 'exists takes a boolean';

    case 'in':
    case 'nin':
      if (!Array.isArray(value) || value.length === 0) {
        return 'must be a non-empty array';
      }
      if (value.length > limits.maxInValues) {
        return `at most ${limits.maxInValues} values are allowed`;
      }
      return value.every(isScalar) ? undefined : 'every value must be a scalar';

    case 'startsWith':
      return typeof value === 'string' ? undefined : 'must be a string';

    case 'contains':
      return typeof value === 'string' || (isScalar(value) && value !== null)
        ? undefined
        : 'must be a string or scalar';

    default:
      return isScalar(value) ? undefined : 'value must be a scalar';
  }
}

/** Parses the `sort` list, enforcing size and identifier rules. */
function parseSort(
  raw: unknown,
  limits: QueryLimits,
  issues: ValidationIssue[],
): SortSpec[] | undefined {
  if (!Array.isArray(raw)) {
    issues.push({ path: 'sort', message: 'must be an array' });
    return undefined;
  }

  if (raw.length > limits.maxSortFields) {
    issues.push({
      path: 'sort',
      message: `at most ${limits.maxSortFields} sort fields are allowed`,
    });
    return undefined;
  }

  const sort: SortSpec[] = [];

  raw.forEach((item, index) => {
    const path = `sort[${index}]`;

    if (!isPlainObject(item)) {
      issues.push({ path, message: 'must be an object' });
      return;
    }

    for (const key of unknownKeys(item, ['field', 'dir'])) {
      issues.push({ path: `${path}.${key}`, message: 'unknown key' });
    }

    if (!isSafeIdentifier(item['field'])) {
      issues.push({ path: `${path}.field`, message: 'invalid field name' });
      return;
    }

    const dir = item['dir'] ?? 'asc';

    if (dir !== 'asc' && dir !== 'desc') {
      issues.push({
        path: `${path}.dir`,
        message: 'must be "asc" or "desc"',
      });
      return;
    }

    sort.push({ field: item['field'], dir });
  });

  return sort;
}

/** Parses the `projection` list; removes duplicate names. */
function parseProjection(
  raw: unknown,
  limits: QueryLimits,
  issues: ValidationIssue[],
): string[] | undefined {
  const valid =
    Array.isArray(raw) &&
    raw.length <= limits.maxProjectionFields &&
    raw.every(isSafeIdentifier);

  if (!valid) {
    issues.push({
      path: 'projection',
      message: 'must be an array of valid field names',
    });
    return undefined;
  }

  return [...new Set(raw as string[])];
}

/** Parses `page`, applying the default and maximum limits. */
function parsePage(
  raw: unknown,
  limits: QueryLimits,
  issues: ValidationIssue[],
): PageSpec {
  const page: PageSpec = { limit: limits.defaultLimit };

  if (!isPlainObject(raw)) {
    issues.push({ path: 'page', message: 'must be an object' });
    return page;
  }

  for (const key of unknownKeys(raw, ['limit', 'cursor'])) {
    const message =
      // Offset paging is slow and unstable on changing data; give a clear hint
      // instead of a generic error.
      key === 'offset'
        ? 'offset pagination is not supported; use a cursor'
        : 'unknown key';

    issues.push({ path: `page.${key}`, message });
  }

  const limit = raw['limit'] ?? limits.defaultLimit;
  const limitIsValid =
    typeof limit === 'number' &&
    Number.isInteger(limit) &&
    limit >= 1 &&
    limit <= limits.maxLimit;

  if (limitIsValid) {
    page.limit = limit;
  } else {
    issues.push({
      path: 'page.limit',
      message: `must be a whole number from 1 to ${limits.maxLimit}`,
    });
  }

  const cursor = raw['cursor'];

  if (cursor !== undefined && cursor !== null) {
    // Only size and type are checked here; the signature is verified later by
    // CursorCodec.
    const cursorIsValid =
      typeof cursor === 'string' &&
      cursor.length > 0 &&
      cursor.length <= limits.maxCursorLength;

    if (cursorIsValid) {
      page.cursor = cursor;
    } else {
      issues.push({ path: 'page.cursor', message: 'invalid cursor' });
    }
  }

  return page;
}

/**
 * Validate untrusted input and return a Query.
 * Throws VALIDATION_FAILED when any problems are found.
 */
export function parseQuery(
  raw: unknown,
  limits: QueryLimits = DEFAULT_QUERY_LIMITS,
): Query {
  if (!isPlainObject(raw)) {
    throw errors.validation('Query must be an object');
  }

  const issues: ValidationIssue[] = [];

  // Unknown top-level keys are errors, not ignored, so typos and smuggled
  // options show up.
  for (const key of unknownKeys(raw, [
    'collection',
    'filter',
    'sort',
    'projection',
    'page',
  ])) {
    issues.push({ path: key, message: 'unknown key' });
  }

  if (!isSafeIdentifier(raw['collection'])) {
    issues.push({
      path: 'collection',
      message: 'invalid collection name',
    });
  }

  const ctx: ParseContext = { limits, issues, nodeCount: 0 };

  const filter =
    raw['filter'] === undefined
      ? undefined
      : parseFilterNode(raw['filter'], 'filter', 1, ctx);

  const sort =
    raw['sort'] === undefined
      ? undefined
      : parseSort(raw['sort'], limits, issues);

  const projection =
    raw['projection'] === undefined
      ? undefined
      : parseProjection(raw['projection'], limits, issues);

  const page =
    raw['page'] === undefined
      ? { limit: limits.defaultLimit }
      : parsePage(raw['page'], limits, issues);

  throwIfIssues(issues, 'Invalid query');

  const query: Query = {
    collection: raw['collection'] as string,
    page,
  };

  if (filter) {
    query.filter = filter;
  }
  if (sort) {
    query.sort = sort;
  }
  if (projection) {
    query.projection = projection;
  }

  return query;
}
