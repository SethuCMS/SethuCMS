/**
 * Pure helpers for the connection registry: building a new collection,
 * checking input, and cutting the model down to what editors may see.
 */
import { type Adapter } from '@sethucms/adapter-sdk';
import {
  CANONICAL_TYPES,
  defineCollection,
  errors,
  isSethuError,
  isPlainObject,
  isSafeIdentifier,
  isSensitiveKey,
  unknownKeys,
  type CanonicalType,
  type CollectionDefinition,
  type FieldDefinition,
} from '@sethucms/core';
import type { ConnectionMode } from '../store/state.js';
import { assertPlainConfig } from './adapters.js';


export const MAX_DECLARED_FIELDS = 100;
export const FIELD_INPUT_KEYS = ['name', 'type', 'required'];

/**
 * Build the definition of a new, empty collection from admin input. Only the
 * key field and the plain fields given are allowed; names are checked here and
 * again by defineCollection, because they end up in the database.
 */
export function buildCollection(
  input: Record<string, unknown>,
  keyField: string,
): CollectionDefinition {
  const name = input['name'];
  if (!isSafeIdentifier(name) || !/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw errors.validation(
      'name must start with a letter and use only letters, numbers and underscores (up to 63 characters)',
    );
  }
  const given = input['fields'] ?? [];
  if (!Array.isArray(given) || given.length > MAX_DECLARED_FIELDS) {
    throw errors.validation(
      `fields must be a list of at most ${MAX_DECLARED_FIELDS} fields`,
    );
  }
  const fields: FieldDefinition[] = [
    {
      name: keyField,
      type: 'string',
      primaryKey: true,
      generated: true,
      required: false,
      lossy: false,
    },
  ];
  for (const item of given) {
    if (!isPlainObject(item)) {
      throw errors.validation('Each field must be an object');
    }
    for (const key of unknownKeys(item, FIELD_INPUT_KEYS)) {
      throw errors.validation(`Unknown field setting: ${key}`);
    }
    const type = item['type'];
    if (
      typeof type !== 'string' ||
      type === 'reference' ||
      !CANONICAL_TYPES.includes(type as CanonicalType)
    ) {
      throw errors.validation(
        'Each field needs a type: ' +
          CANONICAL_TYPES.filter((known) => known !== 'reference').join(', '),
      );
    }
    fields.push({
      name: item['name'] as string,
      type: type as CanonicalType,
      required: item['required'] === true,
    });
  }
  return defineCollection({ name, fields, relations: [] });
}

/** Insert demo records into an empty adapter. */
export async function seedAdapter(
  adapter: Adapter,
  seed: Record<string, Array<Record<string, unknown>>>,
): Promise<void> {
  const collections = new Map(
    (await adapter.introspect()).map((collection) => [
      collection.name,
      collection,
    ]),
  );
  for (const [name, records] of Object.entries(seed)) {
    const collection = collections.get(name);
    if (!collection) {
      continue;
    }
    for (const record of records) {
      await adapter.create(collection, record);
    }
  }
}

/**
 * Keep only the exposed collections. Links to collections that are hidden are
 * removed, so the content model never points at something editors cannot see.
 */
export function exposedSubset(
  all: CollectionDefinition[],
  exposed: Set<string>,
): CollectionDefinition[] {
  return all
    .filter((collection) => exposed.has(collection.name))
    .map((collection) => ({
      ...collection,
      fields: collection.fields.map((field) => {
        if (field.references && !exposed.has(field.references)) {
          const { references: _removed, ...rest } = field;
          return rest;
        }
        return field;
      }),
      relations: collection.relations.filter((relation) =>
        exposed.has(relation.target),
      ),
    }));
}

/** Require 1..max chars of plain text with no control characters. */
export function requireText(value: unknown, name: string, max: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw errors.validation(
      `${name} must be 1 to ${max} characters of plain text`,
    );
  }
  return value.trim();
}

/** Parse the mode; unset means read-only. */
export function parseMode(value: unknown): ConnectionMode {
  if (value === undefined) {
    return 'read_only';
  } // safe by default
  if (value === 'read_only' || value === 'read_write') {
    return value;
  }
  throw errors.validation('mode must be "read_only" or "read_write"');
}

/**
 * Settings may not carry secrets: they are shown in the admin and written to
 * the audit log.
 */
export function cleanConfig(value: unknown): Record<string, unknown> {
  const config = value === undefined ? {} : assertPlainConfig(value);
  for (const key of Object.keys(config)) {
    if (isSensitiveKey(key)) {
      throw errors.validation(`Put "${key}" in credentials, not config`);
    }
  }
  if (JSON.stringify(config).length > 20_000) {
    throw errors.validation('config is too large');
  }
  return config;
}

/** A message that is safe to show to anyone who can see the connection. */
export function safeMessage(error: unknown): string {
  return isSethuError(error) && error.code !== 'INTERNAL'
    ? error.message
    : 'Could not connect to the database';
}

export { isPlainObject };
