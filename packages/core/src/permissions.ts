/**
 * Who may see and change what.
 *
 * Permissions determine which actions a role can perform on a collection,
 * which fields it can access, and which records it can see.
 *
 * When a user has multiple roles, their permissions are merged:
 * - Any matching permission grants access to the action.
 * - Field reads use the most permissive rule: allow, then mask, then hide.
 * - A field is writable if any matching permission allows it.
 * - Row filters are combined with OR. If any permission has no row filter,
 *   the user can access all rows allowed by the other query restrictions.
 *
 * Row filters are always combined with the caller's filter using AND.
 */
import type { CollectionDefinition } from './content-model.js';
import { errors } from './errors.js';
import {
  and,
  collectFilterFields,
  or,
  type Filter,
  type Query,
} from './query-ast.js';
import { hasOwn, isPlainObject } from './util.js';

/**
 * How a field is shown when reading: in full, replaced by a mask, or removed.
 */
export type ReadAccess = 'allow' | 'mask' | 'hide';
/** Whether a field may be written. */
export type WriteAccess = 'allow' | 'deny';
/** Operations a permission can cover. */
export type Action = 'read' | 'create' | 'update' | 'delete';

/** Per-field access rule. Unset parts default to `allow`. */
export interface FieldRule {
  read?: ReadAccess;
  write?: WriteAccess;
  /** Replacement value for masked fields. Defaults to "***". */
  maskWith?: unknown;
}

/** A permission assigned to a role for a particular action. */
export interface Permission {
  action: Action;
  fieldRules?: Record<string, FieldRule>;
  rowFilter?: Filter;
}

/** Permissions resolved for one user, collection, and action. */
export interface ResolvedAccess {
  action: Action;
  fieldRead: ReadonlyMap<string, ReadAccess>;
  fieldWrite: ReadonlyMap<string, WriteAccess>;
  maskWith: ReadonlyMap<string, unknown>;
  /** Undefined means there is no row-level restriction. */
  rowFilter?: Filter;
}

const DEFAULT_MASK = '***';

// Higher rank = more permissive. Used to pick the best rule across roles.
const READ_RANK: Record<ReadAccess, number> = {
  hide: 0,
  mask: 1,
  allow: 2,
};

/** Looks up a field rule on a permission, or undefined if none is set. */
function ruleFor(
  permission: Permission,
  fieldName: string,
): FieldRule | undefined {
  const rules = permission.fieldRules;

  // Own-property check stops field names like `constructor` from hitting
  // inherited object members.
  return rules && hasOwn(rules, fieldName) ? rules[fieldName] : undefined;
}

/** Merge field permissions, giving priority to the most permissive rule. */
function mergeFieldAccess(
  permissions: Permission[],
  collection: CollectionDefinition,
) {
  const fieldRead = new Map<string, ReadAccess>();
  const fieldWrite = new Map<string, WriteAccess>();
  const maskWith = new Map<string, unknown>();

  for (const field of collection.fields) {
    // Start from the most restrictive value and widen only if some permission
    // grants more (deny by default).
    let bestRead: ReadAccess = 'hide';
    let bestWrite: WriteAccess = 'deny';

    for (const permission of permissions) {
      const rule = ruleFor(permission, field.name);
      // A permission without a rule for this field does not restrict it.
      const read = rule?.read ?? 'allow';
      const write = rule?.write ?? 'allow';

      if (READ_RANK[read] > READ_RANK[bestRead]) {
        bestRead = read;
      }

      if (write === 'allow') {
        bestWrite = 'allow';
      }

      if (read === 'mask' && rule && 'maskWith' in rule) {
        maskWith.set(field.name, rule.maskWith);
      }
    }

    fieldRead.set(field.name, bestRead);
    fieldWrite.set(field.name, bestWrite);
  }

  return { fieldRead, fieldWrite, maskWith };
}

/**
 * Combine row filters with OR.
 * If any permission has no filter, there is no row-level restriction.
 */
function mergeRowFilters(permissions: Permission[]): Filter | undefined {
  // One unrestricted permission wins: OR-ing in "all rows" means all rows.
  const allRestricted = permissions.every(
    (permission) => permission.rowFilter !== undefined,
  );

  if (!allRestricted) {
    return undefined;
  }

  const filters = permissions.map(
    (permission) => permission.rowFilter as Filter,
  );

  return filters.length === 1 ? filters[0] : or(...filters);
}

/**
 * Resolve the permissions a user has for a collection and action.
 *
 * @param permissions All permissions held by the user (any action).
 * @param collection Collection being accessed.
 * @param action The operation being attempted.
 * @returns Merged field and row rules for that action.
 * @throws SethuError FORBIDDEN when no permission covers the action.
 */
export function resolveAccess(
  permissions: Permission[],
  collection: CollectionDefinition,
  action: Action,
): ResolvedAccess {
  const matching = permissions.filter(
    (permission) => permission.action === action,
  );

  if (matching.length === 0) {
    throw errors.forbidden(`No ${action} access to ${collection.name}`);
  }

  const rowFilter = mergeRowFilters(matching);

  return {
    action,
    ...mergeFieldAccess(matching, collection),
    ...(rowFilter !== undefined ? { rowFilter } : {}),
  };
}

/**
 * Add the permission's row filter without removing the caller's filter.
 *
 * @param query The caller's query.
 * @param access Resolved access for the user.
 * @returns The query with the row filter ANDed in; unchanged if none.
 */
export function applyRowFilter(query: Query, access: ResolvedAccess): Query {
  if (access.rowFilter === undefined) {
    return query;
  }

  // AND (never replace) so a caller filter can only narrow the rows allowed.
  const filter = query.filter
    ? and(access.rowFilter, query.filter)
    : access.rowFilter;

  return { ...query, filter };
}

/**
 * Restrict a query to fields and records the user can access.
 * Masked fields cannot be used in filters or sorting because those
 * operations could reveal their original values.
 *
 * @param query The caller's query.
 * @param access Resolved read access for the user.
 * @returns A query limited to visible fields and permitted rows.
 * @throws SethuError FORBIDDEN when it uses a field the user cannot use.
 */
export function restrictQuery(query: Query, access: ResolvedAccess): Query {
  // Unknown fields count as hidden (deny by default).
  const readAccessOf = (field: string): ReadAccess =>
    access.fieldRead.get(field) ?? 'hide';

  // Only fully readable fields may be filtered or sorted on; otherwise a caller
  // could guess masked or hidden values by probing.
  for (const field of collectFilterFields(query.filter)) {
    if (readAccessOf(field) !== 'allow') {
      throw errors.forbidden(`Field not available: ${field}`);
    }
  }

  for (const sort of query.sort ?? []) {
    if (readAccessOf(sort.field) !== 'allow') {
      throw errors.forbidden(`Field not available: ${sort.field}`);
    }
  }

  for (const field of query.projection ?? []) {
    if (readAccessOf(field) === 'hide') {
      throw errors.forbidden(`Field not available: ${field}`);
    }
  }

  // Return all visible fields when the caller has not selected a projection.
  // Explicit projection stops adapters returning hidden columns.
  const visibleFields = [...access.fieldRead]
    .filter(([, read]) => read !== 'hide')
    .map(([name]) => name);

  const projection = query.projection ?? visibleFields;

  return applyRowFilter({ ...query, projection }, access);
}

/**
 * Remove hidden fields and replace masked values before returning a record.
 *
 * @param record A full record from the database.
 * @param access Resolved read access for the user.
 * @returns A new object with only visible fields, masked where needed.
 */
export function maskRecord(
  record: Record<string, unknown>,
  access: ResolvedAccess,
): Record<string, unknown> {
  const visible: Record<string, unknown> = {};

  for (const [fieldName, read] of access.fieldRead) {
    // Built from the allowed field list, so extra database columns never leak.
    if (!hasOwn(record, fieldName) || read === 'hide') {
      continue;
    }

    if (read === 'mask') {
      visible[fieldName] = access.maskWith.has(fieldName)
        ? access.maskWith.get(fieldName)
        : DEFAULT_MASK;
    } else {
      visible[fieldName] = record[fieldName];
    }
  }

  return visible;
}

/**
 * Reject writes to fields the user is not allowed to change.
 *
 * @param values Fields the caller wants to write.
 * @param access Resolved write access for the user.
 * @throws SethuError VALIDATION_FAILED if not an object; FORBIDDEN on a non-
 *   writable field.
 */
export function assertWritable(values: unknown, access: ResolvedAccess): void {
  if (!isPlainObject(values)) {
    throw errors.validation('Values must be an object');
  }

  for (const fieldName of Object.keys(values)) {
    // Unlisted fields default to deny, which also blocks mass assignment.
    const writeAccess = access.fieldWrite.get(fieldName) ?? 'deny';

    if (writeAccess !== 'allow') {
      throw errors.forbidden(`Field not writable: ${fieldName}`);
    }
  }
}
