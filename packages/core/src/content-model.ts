/**
 * The content model: which collections exist, what fields they have, and
 * whether a record is acceptable.
 *
 * Collection definitions normally come from introspecting a customer database
 * and are then refined by an admin. Either way they are validated here, so the
 * rest of the system can trust them. A definition doubles as the allowlist of
 * names that may appear in queries.
 */

import {
  CANONICAL_TYPES,
  isValueOfType,
  type CanonicalType,
} from './field-types.js';
import { errors, throwIfIssues, type ValidationIssue } from './errors.js';
import {
  hasOwn,
  isPlainObject,
  isSafeIdentifier,
  unknownKeys,
} from './util.js';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Validation rules that can be configured for a field. */
export interface FieldValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** Regular expression source, checked for common ReDoS risks. */
  pattern?: string;
  enum?: ReadonlyArray<string | number>;
}

/** One column/field of a collection. */
export interface FieldDefinition {
  name: string;
  type: CanonicalType;
  required?: boolean;
  primaryKey?: boolean;
  /** The database generates this value, so clients cannot provide it. */
  generated?: boolean;
  /** Clients can read this field but cannot change it. */
  readOnly?: boolean;
  /** The native database type could not be mapped exactly. */
  lossy?: boolean;
  validation?: FieldValidation;
  /** Target collection for a reference field. */
  references?: string;
}

/** Cardinality of a relation between two collections. */
export type RelationKind =
  'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';

/** A named link from one collection to another. */
export interface RelationDefinition {
  name: string;
  /** Collection on the other side of the relation. */
  target: string;
  kind: RelationKind;
  /** Maps source field names to target field names. */
  mapping: Record<string, string>;
}

/** A validated, immutable description of one collection. */
export interface CollectionDefinition {
  /** Name exposed through the CMS and its API. */
  name: string;
  /** Actual database name, if it differs from the public name. */
  nativeName?: string;
  fields: FieldDefinition[];
  relations: RelationDefinition[];
}

// Key lists below are allowlists used to reject unknown keys.
const RELATION_KINDS: readonly RelationKind[] = [
  'one_to_one',
  'one_to_many',
  'many_to_one',
  'many_to_many',
];

const FIELD_KEYS = [
  'name',
  'type',
  'required',
  'primaryKey',
  'generated',
  'readOnly',
  'lossy',
  'validation',
  'references',
];

const VALIDATION_KEYS = [
  'min',
  'max',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
];
const RELATION_KEYS = ['name', 'target', 'kind', 'mapping'];
const COLLECTION_KEYS = ['name', 'nativeName', 'fields', 'relations'];

// -----------------------------------------------------------------------------
// Collection definition validation
// -----------------------------------------------------------------------------

// Length cap limits how complex a pattern can be.
const MAX_PATTERN_LENGTH = 200;

// A simple heuristic for nested quantifiers such as (a+)+, which can cause
// catastrophic backtracking. This is not a complete regex safety check.
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*{]/;

/** Returns an error message when a pattern is invalid or looks unsafe. */
function describePatternProblem(pattern: unknown): string | undefined {
  if (typeof pattern !== 'string' || pattern.length > MAX_PATTERN_LENGTH) {
    return `pattern must be a string of at most ${MAX_PATTERN_LENGTH} characters`;
  }

  if (NESTED_QUANTIFIER.test(pattern)) {
    return 'pattern looks vulnerable to catastrophic backtracking';
  }

  try {
    new RegExp(pattern);
  } catch {
    return 'invalid regular expression';
  }

  return undefined;
}

/** Validates a field's `validation` block and appends any issues. */
function checkValidationRules(
  rules: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isPlainObject(rules)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }

  for (const key of unknownKeys(rules, VALIDATION_KEYS)) {
    issues.push({ path: `${path}.${key}`, message: 'unknown key' });
  }

  if (rules['pattern'] !== undefined) {
    const problem = describePatternProblem(rules['pattern']);
    if (problem) {
      issues.push({ path: `${path}.pattern`, message: problem });
    }
  }
}

/** Validates a field definition and reports any problems found. */
function checkFieldDefinition(
  field: unknown,
  path: string,
  issues: ValidationIssue[],
): field is FieldDefinition {
  if (!isPlainObject(field)) {
    issues.push({ path, message: 'must be an object' });
    return false;
  }

  const issuesBefore = issues.length;

  for (const key of unknownKeys(field, FIELD_KEYS)) {
    issues.push({ path: `${path}.${key}`, message: 'unknown key' });
  }

  if (!isSafeIdentifier(field['name'])) {
    issues.push({ path: `${path}.name`, message: 'invalid identifier' });
  }

  if (!CANONICAL_TYPES.includes(field['type'] as CanonicalType)) {
    issues.push({ path: `${path}.type`, message: 'unknown canonical type' });
  }

  if (field['type'] === 'reference' && !isSafeIdentifier(field['references'])) {
    issues.push({
      path: `${path}.references`,
      message: 'reference fields need a target collection',
    });
  }

  if (field['validation'] !== undefined) {
    checkValidationRules(field['validation'], `${path}.validation`, issues);
  }

  return issues.length === issuesBefore;
}

/** Validates a relation and tracks used names to reject duplicates. */
function checkRelationDefinition(
  relation: unknown,
  path: string,
  seenNames: Set<string>,
  issues: ValidationIssue[],
): void {
  if (!isPlainObject(relation)) {
    issues.push({ path, message: 'must be an object' });
    return;
  }

  for (const key of unknownKeys(relation, RELATION_KEYS)) {
    issues.push({ path: `${path}.${key}`, message: 'unknown key' });
  }

  const name = relation['name'];
  if (!isSafeIdentifier(name)) {
    issues.push({ path: `${path}.name`, message: 'invalid identifier' });
  } else if (seenNames.has(name)) {
    issues.push({ path: `${path}.name`, message: 'duplicate relation name' });
  } else {
    seenNames.add(name);
  }

  if (!isSafeIdentifier(relation['target'])) {
    issues.push({ path: `${path}.target`, message: 'invalid identifier' });
  }

  if (!RELATION_KINDS.includes(relation['kind'] as RelationKind)) {
    issues.push({ path: `${path}.kind`, message: 'unknown relation kind' });
  }

  const mapping = relation['mapping'];
  const mappingIsValid =
    isPlainObject(mapping) &&
    Object.keys(mapping).length > 0 &&
    Object.entries(mapping).every(
      ([from, to]) => isSafeIdentifier(from) && isSafeIdentifier(to),
    );

  if (!mappingIsValid) {
    issues.push({
      path: `${path}.mapping`,
      message: 'mapping must be a non-empty map of field names',
    });
  }
}

/** Validates the field list: names unique, at least one primary key. */
function checkFieldList(fields: unknown, issues: ValidationIssue[]): void {
  if (!Array.isArray(fields) || fields.length === 0) {
    issues.push({ path: 'fields', message: 'at least one field is required' });
    return;
  }

  const seenNames = new Set<string>();
  let primaryKeyCount = 0;

  fields.forEach((field, index) => {
    if (!checkFieldDefinition(field, `fields[${index}]`, issues)) {
      return;
    }

    if (seenNames.has(field.name)) {
      issues.push({
        path: `fields[${index}].name`,
        message: 'duplicate field name',
      });
    }
    seenNames.add(field.name);

    if (field.primaryKey) {
      primaryKeyCount += 1;
    }
  });

  if (primaryKeyCount === 0) {
    issues.push({ path: 'fields', message: 'a primary key field is required' });
  }
}

/** Freezes an object and its nested values. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    // Frozen so a validated definition cannot be altered later.
    Object.freeze(value);
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
  }

  return value;
}

/**
 * Validates untrusted input and returns an immutable collection definition.
 * Throws VALIDATION_FAILED when one or more problems are found.
 */
export function defineCollection(input: unknown): CollectionDefinition {
  if (!isPlainObject(input)) {
    throw errors.validation('Collection must be an object');
  }

  const issues: ValidationIssue[] = [];

  for (const key of unknownKeys(input, COLLECTION_KEYS)) {
    issues.push({ path: key, message: 'unknown key' });
  }

  if (!isSafeIdentifier(input['name'])) {
    issues.push({ path: 'name', message: 'invalid identifier' });
  }

  checkFieldList(input['fields'], issues);

  const relations = input['relations'] ?? [];
  if (!Array.isArray(relations)) {
    issues.push({ path: 'relations', message: 'must be an array' });
  } else {
    const seenRelationNames = new Set<string>();
    relations.forEach((relation, index) => {
      checkRelationDefinition(
        relation,
        `relations[${index}]`,
        seenRelationNames,
        issues,
      );
    });
  }

  throwIfIssues(issues, 'Invalid collection definition');

  const definition = input as unknown as CollectionDefinition;
  return deepFreeze({
    ...definition,
    relations: [...(definition.relations ?? [])],
  });
}

// -----------------------------------------------------------------------------
// Collection lookups
// -----------------------------------------------------------------------------

/** @returns The field with that name, or undefined. */
export function getField(
  collection: CollectionDefinition,
  name: string,
): FieldDefinition | undefined {
  return collection.fields.find((field) => field.name === name);
}

/**
 * @returns The collection's primary key field.
 * @throws SethuError INTERNAL if there is none (defineCollection prevents
 *   this).
 */
export function primaryKeyOf(
  collection: CollectionDefinition,
): FieldDefinition {
  const key = collection.fields.find((field) => field.primaryKey);
  if (!key) {
    throw errors.internal('Collection has no primary key');
  }
  return key;
}

/**
 * Finds the collection referenced by a field. Adapters can provide this through
 * the field's `references` property or through a many-to-one relation whose
 * source field maps directly to the target collection's primary key.
 */
export function referencedCollection(
  collection: CollectionDefinition,
  field: FieldDefinition,
  all: ReadonlyMap<string, CollectionDefinition>,
): string | undefined {
  if (field.references) {
    return field.references;
  }

  for (const relation of collection.relations) {
    if (relation.kind !== 'many_to_one') {
      continue;
    }

    const entries = Object.entries(relation.mapping);
    const [only] = entries;
    if (entries.length !== 1 || !only || only[0] !== field.name) {
      continue;
    }

    const target = all.get(relation.target);
    if (target && primaryKeyOf(target).name === only[1]) {
      return relation.target;
    }
  }

  return undefined;
}

/** Holds and validates the collection definitions for one connection. */
export class ContentModel {
  private readonly collectionsByName = new Map<string, CollectionDefinition>();

  constructor(collections: CollectionDefinition[]) {
    for (const collection of collections) {
      if (this.collectionsByName.has(collection.name)) {
        throw errors.validation(`Duplicate collection: ${collection.name}`);
      }
      // Names are unique, so each is a safe lookup key.
      this.collectionsByName.set(collection.name, collection);
    }

    throwIfIssues(this.findBrokenLinks(collections), 'Invalid content model');
  }

  /** True if a collection with this name exists. */
  has(name: string): boolean {
    return this.collectionsByName.has(name);
  }

  /** The collection with this name, or undefined. */
  get(name: string): CollectionDefinition | undefined {
    return this.collectionsByName.get(name);
  }

  /** Like `get`, but throws NOT_FOUND when the collection does not exist. */
  require(name: string): CollectionDefinition {
    const collection = this.collectionsByName.get(name);
    if (!collection) {
      throw errors.notFound('Unknown collection');
    }
    return collection;
  }

  /** All collections, in insertion order. */
  list(): CollectionDefinition[] {
    return [...this.collectionsByName.values()];
  }

  /**
   * Finds references and relations that point at unknown collections or fields.
   */
  private findBrokenLinks(
    collections: CollectionDefinition[],
  ): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const collection of collections) {
      for (const field of collection.fields) {
        const target = field.references;
        if (field.type === 'reference' && target && !this.has(target)) {
          issues.push({
            path: `${collection.name}.${field.name}`,
            message: `references unknown collection ${target}`,
          });
        }
      }

      for (const relation of collection.relations) {
        const target = this.get(relation.target);
        const path = `${collection.name}.${relation.name}`;

        if (!target) {
          issues.push({ path, message: `unknown target ${relation.target}` });
          continue;
        }

        for (const [sourceField, targetField] of Object.entries(
          relation.mapping,
        )) {
          if (!getField(collection, sourceField)) {
            issues.push({
              path,
              message: `unknown source field ${sourceField}`,
            });
          }
          if (!getField(target, targetField)) {
            issues.push({
              path,
              message: `unknown target field ${targetField}`,
            });
          }
        }
      }
    }

    return issues;
  }
}

// -----------------------------------------------------------------------------
// Record validation
// -----------------------------------------------------------------------------

/** Whether a record is being created or updated. */
export type RecordMode = 'create' | 'update';

/** Applies the validation rules configured for a field. */
function checkFieldRules(
  field: FieldDefinition,
  value: unknown,
  issues: ValidationIssue[],
): void {
  const rules = field.validation;
  if (!rules) {
    return;
  }

  const path = field.name;

  if (typeof value === 'number') {
    if (rules.min !== undefined && value < rules.min) {
      issues.push({ path, message: `must be at least ${rules.min}` });
    }
    if (rules.max !== undefined && value > rules.max) {
      issues.push({ path, message: `must be at most ${rules.max}` });
    }
  }

  if (typeof value === 'string') {
    if (rules.minLength !== undefined && value.length < rules.minLength) {
      issues.push({
        path,
        message: `must be at least ${rules.minLength} characters`,
      });
    }
    if (rules.maxLength !== undefined && value.length > rules.maxLength) {
      issues.push({
        path,
        message: `must be at most ${rules.maxLength} characters`,
      });
    }
    // Pattern was screened at definition time, so building the RegExp here is
    // considered safe.
    if (rules.pattern !== undefined && !new RegExp(rules.pattern).test(value)) {
      issues.push({ path, message: 'does not match the required pattern' });
    }
  }

  if (rules.enum && !rules.enum.includes(value as string | number)) {
    issues.push({ path, message: 'is not an allowed value' });
  }
}

/** Returns why a client is not allowed to write to a field, if applicable. */
function describeWriteBlock(
  field: FieldDefinition,
  mode: RecordMode,
): string | undefined {
  if (field.generated || field.readOnly) {
    return 'field is read-only';
  }
  if (mode === 'update' && field.primaryKey) {
    return 'primary key cannot be changed';
  }
  return undefined;
}

/**
 * Validates a client record before it is written. Unknown and read-only fields
 * are rejected to prevent mass-assignment issues, such as setting `isAdmin`.
 */
export function validateRecord(
  collection: CollectionDefinition,
  record: unknown,
  mode: RecordMode,
): ValidationIssue[] {
  if (!isPlainObject(record)) {
    return [{ path: '', message: 'record must be an object' }];
  }

  const issues: ValidationIssue[] = [];
  const fieldsByName = new Map(
    collection.fields.map((field) => [field.name, field]),
  );

  for (const [name, value] of Object.entries(record)) {
    const field = fieldsByName.get(name);
    if (!field) {
      issues.push({ path: name, message: 'unknown field' });
      continue;
    }

    const blockReason = describeWriteBlock(field, mode);
    if (blockReason) {
      issues.push({ path: name, message: blockReason });
      continue;
    }

    // Null clears a value; it is only refused when the field is required.
    if (value === null) {
      if (field.required) {
        issues.push({ path: name, message: 'is required' });
      }
      continue;
    }

    if (!isValueOfType(field.type, value)) {
      issues.push({ path: name, message: `must be of type ${field.type}` });
      continue;
    }

    checkFieldRules(field, value, issues);
  }

  // Updates may be partial, so required fields are only enforced on create.
  // Generated fields are excluded because the database fills them.
  if (mode === 'create') {
    for (const field of collection.fields) {
      const mustBeSupplied = field.required && !field.generated;
      if (mustBeSupplied && !hasOwn(record, field.name)) {
        issues.push({ path: field.name, message: 'is required' });
      }
    }
  }

  return issues;
}

/** Validates a record and throws VALIDATION_FAILED if it contains issues. */
export function assertValidRecord(
  collection: CollectionDefinition,
  record: unknown,
  mode: RecordMode,
): void {
  throwIfIssues(validateRecord(collection, record, mode), 'Invalid record');
}
