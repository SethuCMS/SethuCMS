/**
 * Checks a query against the collection definition and database capabilities.
 *
 * validateQuery checks whether fields and operators make sense for the
 * collection. checkCapabilities checks whether the selected database can run
 * the query. Together, they prevent invalid queries from reaching an adapter.
 *
 * Field names must exist in the collection definition before they can be used.
 */
import type { Capabilities } from './capabilities.js';
import type { CollectionDefinition, FieldDefinition } from './content-model.js';
import { errors, throwIfIssues, type ValidationIssue } from './errors.js';
import {
  OPS_BY_TYPE,
  SORTABLE_TYPES,
  isValueOfType,
  type CanonicalType,
} from './field-types.js';
import {
  collectFilterFields,
  isComparison,
  walkFilter,
  type Comparison,
  type Filter,
  type Query,
} from './query-ast.js';

// ---------------------------------------------------------------------------
// 1. Validate the query against the collection
// ---------------------------------------------------------------------------

/** Returns the expected value type for a comparison, when applicable. */
function expectedValueType(
  comparison: Comparison,
  field: FieldDefinition,
): CanonicalType | 'string' | undefined {
  const { op } = comparison;

  // Array membership takes an element of unknown type, so it is not type-
  // checked here.
  if (op === 'contains' && field.type === 'array') {
    return undefined;
  }

  if (op === 'contains' || op === 'startsWith') {
    return 'string';
  }

  return field.type;
}

/** Returns the values to validate for a comparison. */
function valuesOf(comparison: Comparison): unknown[] {
  if (comparison.op === 'exists') {
    return [];
  }

  if (comparison.op === 'in' || comparison.op === 'nin') {
    return comparison.value as unknown[];
  }

  return [comparison.value];
}

/** Validates one comparison against its field and appends any issues. */
function checkComparison(
  comparison: Comparison,
  fields: Map<string, FieldDefinition>,
  issues: ValidationIssue[],
): void {
  const path = `filter.${comparison.field}`;
  // Unknown names are rejected: the collection definition is the allowlist of
  // names that may reach an adapter.
  const field = fields.get(comparison.field);

  if (!field) {
    issues.push({ path, message: 'unknown field' });
    return;
  }

  if (!OPS_BY_TYPE[field.type].includes(comparison.op)) {
    issues.push({
      path,
      message: `operator ${comparison.op} is not allowed on ${field.type} fields`,
    });
    return;
  }

  const expected = expectedValueType(comparison, field);

  if (!expected) {
    return;
  }

  for (const value of valuesOf(comparison)) {
    // null is allowed for any type (matches missing/empty values).
    if (value === null) {
      continue;
    }

    if (!isValueOfType(expected, value)) {
      issues.push({
        path,
        message: `value must be of type ${expected}`,
      });
    }
  }
}

/**
 * Returns validation issues, or an empty array when the query is valid.
 *
 * @param query A parsed query.
 * @param collection Definition the query targets.
 */
export function validateQuery(
  query: Query,
  collection: CollectionDefinition,
): ValidationIssue[] {
  if (query.collection !== collection.name) {
    return [{ path: 'collection', message: 'collection does not match' }];
  }

  const issues: ValidationIssue[] = [];
  const fields = new Map(collection.fields.map((field) => [field.name, field]));

  if (query.filter) {
    walkFilter(query.filter, (comparison) => {
      checkComparison(comparison, fields, issues);
    });
  }

  query.sort?.forEach((sort, index) => {
    const field = fields.get(sort.field);

    if (!field) {
      issues.push({
        path: `sort[${index}].field`,
        message: 'unknown field',
      });
      return;
    }

    if (!SORTABLE_TYPES.has(field.type)) {
      issues.push({
        path: `sort[${index}].field`,
        message: `cannot sort by ${field.type}`,
      });
    }
  });

  query.projection?.forEach((name, index) => {
    if (!fields.has(name)) {
      issues.push({
        path: `projection[${index}]`,
        message: 'unknown field',
      });
    }
  });

  return issues;
}

// ---------------------------------------------------------------------------
// 2. Check database capabilities
// ---------------------------------------------------------------------------

export interface CapabilityCheck {
  /** Features the database cannot support for this query. */
  violations: string[];
  /** Potential issues that depend on the database configuration. */
  notes: string[];
}

// Operators that databases like Firestore count as inequality filters.
const INEQUALITY_OPERATORS = ['lt', 'lte', 'gt', 'gte', 'ne', 'nin'];

/** Summarizes the filter features used by a query. */
/** Walks a filter tree and records OR use and inequality fields. */
function describeFilter(filter: Filter | undefined): {
  usesOr: boolean;
  inequalityFields: Set<string>;
} {
  const summary = {
    usesOr: false,
    inequalityFields: new Set<string>(),
  };

  function visit(node: Filter): void {
    if (isComparison(node)) {
      if (INEQUALITY_OPERATORS.includes(node.op)) {
        summary.inequalityFields.add(node.field);
      }
    } else if ('or' in node) {
      summary.usesOr = true;
      node.or.forEach(visit);
    } else if ('and' in node) {
      node.and.forEach(visit);
    } else {
      visit(node.not);
    }
  }

  if (filter) {
    visit(filter);
  }

  return summary;
}

/**
 * Checks whether the database supports the features used by a query.
 *
 * @param query A parsed query.
 * @param capabilities What the target database supports.
 * @param collection Needed to know the key field for key-only sorting.
 * @returns Hard violations and softer notes; does not throw.
 */
export function checkCapabilities(
  query: Query,
  capabilities: Capabilities,
  collection?: CollectionDefinition,
): CapabilityCheck {
  const violations: string[] = [];
  const notes: string[] = [];

  const { usesOr, inequalityFields } = describeFilter(query.filter);

  // Filtering support.
  if (usesOr && !capabilities.filters.or) {
    violations.push('This database does not support OR filters');
  }

  if (capabilities.filters.inequality === 'none' && inequalityFields.size > 0) {
    violations.push('This database does not support inequality filters');
  }

  if (
    capabilities.filters.inequality === 'single-field' &&
    inequalityFields.size > 1
  ) {
    violations.push(
      'This database supports inequality filters on only one field per query',
    );
  }

  // Sorting support.
  const sortFields = query.sort ?? [];

  if (sortFields.length > 0) {
    if (capabilities.sort === 'key-only') {
      const keyName = collection?.fields.find(
        (field) => field.primaryKey,
      )?.name;

      const sortsByAnotherField = sortFields.some(
        (sort) => sort.field !== keyName,
      );

      if (!keyName || sortsByAnotherField) {
        violations.push('This database can only sort by its key');
      }
    } else if (capabilities.sort === 'indexed-only') {
      notes.push(
        'Sorting needs an index on the sort fields; the database may reject the query without one',
      );
    }
  }

  // Some databases require the inequality field to be sorted first.
  const firstSort = sortFields[0];

  if (
    capabilities.filters.inequality === 'single-field' &&
    inequalityFields.size === 1 &&
    firstSort
  ) {
    const [inequalityField] = [...inequalityFields];

    if (firstSort.field !== inequalityField) {
      notes.push(
        'The first sort field should be the same as the inequality filter field',
      );
    }
  }

  return { violations, notes };
}

/**
 * Validates a query and checks whether the database can execute it.
 * Throws when validation fails or the database lacks a required feature.
 *
 * @param query A parsed query.
 * @param collection Definition the query targets.
 * @param capabilities What the target database supports.
 * @returns Notes about possible issues (e.g. missing indexes).
 * @throws SethuError VALIDATION_FAILED or CAPABILITY_UNSUPPORTED.
 */
export function planQuery(
  query: Query,
  collection: CollectionDefinition,
  capabilities: Capabilities,
): { notes: string[] } {
  throwIfIssues(validateQuery(query, collection), 'Invalid query');

  const { violations, notes } = checkCapabilities(
    query,
    capabilities,
    collection,
  );

  if (violations.length > 0) {
    throw errors.unsupported(violations.join('; '), { violations });
  }

  return { notes };
}

// Re-exported so callers of planQuery can find filter fields without importing
// query-ast.
export { collectFilterFields };
