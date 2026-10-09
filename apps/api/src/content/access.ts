/**
 * Small helpers that apply the core permission rules for one caller.
 */
import {
  eq,
  isPlainObject,
  hasOwn,
  errors,
  maskRecord,
  primaryKeyOf,
  resolveAccess,
  applyRowFilter,
  type Action,
  type CollectionDefinition,
  type ResolvedAccess,
} from '@sethucms/core';
import { permissionsFor, type Principal } from '../auth.js';
import type { Bound } from '../connections/registry.js';

/**
 * Work out what `principal` may do to `collection` for one action.
 *
 * @returns Resolved access: allowed fields, masks and any row filter.
 * @throws A forbidden error if the role may not perform the action at all.
 */
export function accessFor(
  principal: Principal,
  collection: CollectionDefinition,
  action: Action,
): ResolvedAccess {
  return resolveAccess(permissionsFor(principal), collection, action);
}

/** Read access if the caller has it, otherwise null. */
export function tryReadAccess(
  principal: Principal,
  collection: CollectionDefinition,
): ResolvedAccess | null {
  try {
    return accessFor(principal, collection, 'read');
  } catch {
    return null;
  }
}

/**
 * What the caller may see of a record. Callers without read access only see the
 * id.
 */
// Without read access only the primary key is returned, never other values.
export function visibleRecord(
  principal: Principal,
  collection: CollectionDefinition,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const read = tryReadAccess(principal, collection);
  if (read) {
    return maskRecord(record, read);
  }
  const key = primaryKeyOf(collection).name;
  return { [key]: record[key] };
}

/** Ids from the URL are text. Convert them to the primary key's type. */
// Strict digit check (and length cap) so "1e3" or huge numbers are not
// silently coerced. A bad id looks like a missing record.
export function idValue(
  collection: CollectionDefinition,
  id: string,
): string | number {
  if (primaryKeyOf(collection).type === 'integer') {
    if (!/^-?\d{1,15}$/.test(id)) {
      throw errors.notFound('Record not found');
    }
    return Number(id);
  }
  return id;
}

/**
 * Row rules (for example "editors only see their own articles") apply to
 * single records too. Returns true when the record is inside the caller's rows.
 */
// Answered with a 1-row query through the guarded adapter so the same
// row filter used for lists applies to single-record access.
export async function isRecordInScope(
  bound: Bound,
  collection: CollectionDefinition,
  access: ResolvedAccess,
  id: string,
): Promise<boolean> {
  const key = primaryKeyOf(collection).name;
  const query = applyRowFilter(
    {
      collection: collection.name,
      filter: eq(key, idValue(collection, id)),
      projection: [key],
      page: { limit: 1 },
    },
    access,
  );
  const page = await bound.guarded.find(query);
  return page.records.length > 0;
}

/**
 * Names that are not fields of the collection are a mistake in the request
 * (400), not a permission problem (403), so check them first.
 */
// `hasOwn` also rejects inherited keys such as `__proto__`.
export function rejectUnknownFields(
  collection: CollectionDefinition,
  values: unknown,
): void {
  if (!isPlainObject(values)) {
    throw errors.validation('Values must be an object');
  }
  const known = new Set(collection.fields.map((field) => field.name));
  for (const name of Object.keys(values)) {
    if (!known.has(name) || !hasOwn(values, name)) {
      throw errors.validation(`Unknown field: ${name.slice(0, 60)}`);
    }
  }
}
