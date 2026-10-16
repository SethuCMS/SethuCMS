/**
 * Schema as code.
 *
 * The database says what exists; a schema file says how it is edited. The file
 * can rename and describe fields, choose the editor for each (code box, image,
 * file), hide the ones nobody should touch by default, make a field read-only
 * or required, and add limits. It never creates, renames or drops anything in a
 * customer database, and it cannot loosen a rule the database already has.
 *
 * Where it comes from (first one wins):
 *   - `schema` in the gateway options
 *   - SETHUCMS_SCHEMA       the schema as JSON
 *   - SETHUCMS_SCHEMA_FILE  a .json file, or a .mjs/.js (and .ts on Node 23.6+)
 *                           module whose default export is the schema
 */
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CollectionDefinition,
  FieldDefinition,
  FieldValidation,
} from '@sethucms/core';
import type {
  CollectionSchema,
  FieldSchema,
  SchemaFile,
  Widget,
} from './define.js';

export type { CollectionSchema, FieldSchema, SchemaFile, Widget };

const WIDGETS: readonly Widget[] = ['text', 'textarea', 'code', 'image', 'file'];
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_BYTES = 512 * 1024;
const MAX_COLLECTIONS = 200;
const MAX_FIELDS = 300;

/** A problem in the schema file, worded for the person who wrote it. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(`Schema: ${message}`);
    this.name = 'SchemaError';
  }
}

export interface LoadedSchema {
  collections: CollectionSchema[];
  /** Where it came from, without any server path. */
  source: string;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function only(value: Obj, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SchemaError(
        `${where} has an unknown setting "${key}". Allowed: ${allowed.join(', ')}.`,
      );
    }
  }
}

function text(value: unknown, where: string, max: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new SchemaError(`${where} must be text of 1 to ${max} characters.`);
  }
  // Shown in the admin as plain text; control characters have no place in it.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new SchemaError(`${where} must not contain control characters.`);
  }
  return value;
}

function flag(value: unknown, where: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new SchemaError(`${where} must be true or false.`);
  }
  return value;
}

function count(value: unknown, where: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SchemaError(`${where} must be a number.`);
  }
  return value;
}

function nameOf(value: unknown, where: string): string {
  if (typeof value !== 'string' || !NAME.test(value) || value === '__proto__') {
    throw new SchemaError(
      `${where} needs a name of letters, digits, _ . - (up to 64, not starting with a digit).`,
    );
  }
  return value;
}

const FIELD_KEYS = [
  'name', 'type', 'label', 'description', 'widget', 'hidden', 'readOnly',
  'required', 'min', 'max', 'minLength', 'maxLength', 'options',
] as const;
const COLLECTION_KEYS = ['name', 'title', 'titleField', 'strict', 'fields'] as const;

function parseField(input: unknown, where: string): FieldSchema {
  if (!isObj(input)) {
    throw new SchemaError(`${where} must be an object like { name: 'title' }.`);
  }
  only(input, FIELD_KEYS, where);
  const name = nameOf(input['name'], where);
  const here = `${where} "${name}"`;
  const field: FieldSchema = { name };
  const set = <K extends keyof FieldSchema>(key: K, value: FieldSchema[K] | undefined) => {
    if (value !== undefined) {
      field[key] = value;
    }
  };
  set('type', text(input['type'], `${here} type`, 40));
  set('label', text(input['label'], `${here} label`, 80));
  set('description', text(input['description'], `${here} description`, 300));
  const widget = input['widget'];
  if (widget !== undefined) {
    if (typeof widget !== 'string' || !WIDGETS.includes(widget as Widget)) {
      throw new SchemaError(`${here} widget must be one of ${WIDGETS.join(', ')}.`);
    }
    field.widget = widget as Widget;
  }
  set('hidden', flag(input['hidden'], `${here} hidden`));
  set('readOnly', flag(input['readOnly'], `${here} readOnly`));
  set('required', flag(input['required'], `${here} required`));
  set('min', count(input['min'], `${here} min`));
  set('max', count(input['max'], `${here} max`));
  set('minLength', count(input['minLength'], `${here} minLength`));
  set('maxLength', count(input['maxLength'], `${here} maxLength`));
  const options = input['options'];
  if (options !== undefined) {
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      options.length > 100 ||
      !options.every(
        (item) =>
          (typeof item === 'string' && item.length <= 200) ||
          (typeof item === 'number' && Number.isFinite(item)),
      )
    ) {
      throw new SchemaError(`${here} options must be a list of 1 to 100 texts or numbers.`);
    }
    field.options = options as Array<string | number>;
  }
  return field;
}

/** Check an untrusted schema (from JSON, a module or the environment). */
export function parseSchema(input: unknown): SchemaFile {
  const root = Array.isArray(input) ? { collections: input } : input;
  if (!isObj(root)) {
    throw new SchemaError('must be an object with a "collections" list.');
  }
  only(root, ['collections'], 'The schema');
  const list = root['collections'];
  if (!Array.isArray(list) || list.length > MAX_COLLECTIONS) {
    throw new SchemaError(`"collections" must be a list of up to ${MAX_COLLECTIONS}.`);
  }
  const seen = new Set<string>();
  const collections = list.map((item): CollectionSchema => {
    if (!isObj(item)) {
      throw new SchemaError('each collection must be an object like { name: "posts" }.');
    }
    only(item, COLLECTION_KEYS, 'A collection');
    const name = nameOf(item['name'], 'A collection');
    if (seen.has(name)) {
      throw new SchemaError(`collection "${name}" is listed twice.`);
    }
    seen.add(name);
    const here = `collection "${name}"`;
    const out: CollectionSchema = { name };
    const title = text(item['title'], `${here} title`, 80);
    if (title !== undefined) {
      out.title = title;
    }
    if (item['titleField'] !== undefined) {
      out.titleField = nameOf(item['titleField'], `${here} titleField`);
    }
    const strict = flag(item['strict'], `${here} strict`);
    if (strict !== undefined) {
      out.strict = strict;
    }
    const fields = item['fields'];
    if (fields !== undefined) {
      if (!Array.isArray(fields) || fields.length > MAX_FIELDS) {
        throw new SchemaError(`${here} fields must be a list of up to ${MAX_FIELDS}.`);
      }
      const names = new Set<string>();
      out.fields = fields.map((field) => {
        const parsed = parseField(field, `${here} field`);
        if (names.has(parsed.name)) {
          throw new SchemaError(`${here} lists field "${parsed.name}" twice.`);
        }
        names.add(parsed.name);
        return parsed;
      });
      if (out.titleField && !names.has(out.titleField)) {
        throw new SchemaError(`${here} titleField "${out.titleField}" is not in its fields.`);
      }
    }
    return out;
  });
  return { collections };
}

// ---- Loading ---------------------------------------------------------------

/**
 * Find and check the schema. Returns undefined when none is configured and
 * throws a SchemaError when one is configured but wrong, so a typo stops the
 * start instead of silently showing the wrong form.
 */
export async function loadSchema(
  env: NodeJS.ProcessEnv,
  supplied?: unknown,
): Promise<LoadedSchema | undefined> {
  if (supplied !== undefined) {
    return { ...parseSchema(supplied), source: 'options' };
  }
  const inline = env['SETHUCMS_SCHEMA'];
  if (inline && inline.trim() !== '') {
    if (inline.length > MAX_BYTES) {
      throw new SchemaError('SETHUCMS_SCHEMA is too large.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new SchemaError('SETHUCMS_SCHEMA is not valid JSON.');
    }
    return { ...parseSchema(parsed), source: 'SETHUCMS_SCHEMA' };
  }
  const file = env['SETHUCMS_SCHEMA_FILE'];
  if (!file || file.trim() === '') {
    return undefined;
  }
  const path = resolve(file);
  const label = basename(path);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new SchemaError(`the file ${label} (SETHUCMS_SCHEMA_FILE) was not found.`);
  }
  if (size > MAX_BYTES) {
    throw new SchemaError(`${label} is larger than ${MAX_BYTES / 1024} KB.`);
  }
  let raw: unknown;
  if (extname(path).toLowerCase() === '.json') {
    try {
      raw = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new SchemaError(`${label} is not valid JSON.`);
    }
  } else {
    try {
      const loaded = (await import(pathToFileURL(path).href)) as Obj;
      raw = loaded['default'] ?? loaded['schema'];
    } catch (error) {
      throw new SchemaError(
        `${label} could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}. ` +
          'Use a .json or .mjs file (a .ts file needs Node 23.6 or newer).',
      );
    }
    if (raw === undefined) {
      throw new SchemaError(`${label} must export the schema as its default export.`);
    }
  }
  return { ...parseSchema(raw), source: label };
}

// ---- Applying --------------------------------------------------------------

/** What the admin is told about one field, on top of what the database says. */
export interface FieldUi {
  label?: string;
  description?: string;
  widget?: Widget;
  hidden?: boolean;
}

export interface CollectionUi {
  title?: string;
  titleField?: string;
  fields: Map<string, FieldUi>;
}

export interface Applied {
  collections: CollectionDefinition[];
  ui: Map<string, CollectionUi>;
  /** Things the schema says that this database does not match. */
  notes: string[];
}

/**
 * Lay the schema over what the database reports. Only ever tightens: the
 * database's own required, read-only and limit rules always stay.
 */
export function applySchema(
  found: CollectionDefinition[],
  schema: LoadedSchema | undefined,
): Applied {
  const ui = new Map<string, CollectionUi>();
  const notes: string[] = [];
  if (!schema) {
    return { collections: found, ui, notes };
  }
  const byName = new Map(schema.collections.map((item) => [item.name, item]));
  for (const item of schema.collections) {
    if (!found.some((collection) => collection.name === item.name)) {
      notes.push(`Collection "${item.name}" is in the schema but not in this connection.`);
    }
  }
  const collections = found.map((collection) => {
    const coded = byName.get(collection.name);
    if (!coded) {
      return collection;
    }
    const listed = new Map((coded.fields ?? []).map((field) => [field.name, field]));
    const present = new Set(collection.fields.map((field) => field.name));
    for (const name of listed.keys()) {
      if (!present.has(name)) {
        notes.push(`"${collection.name}.${name}" is in the schema but not in the database.`);
      }
    }
    if (coded.titleField && !present.has(coded.titleField)) {
      notes.push(`"${collection.name}" titleField "${coded.titleField}" is not in the database.`);
    }
    const fieldUi = new Map<string, FieldUi>();
    const fields = collection.fields.map((field): FieldDefinition => {
      const wanted = listed.get(field.name);
      const marks: FieldUi = {};
      // Under `strict`, what is not listed stays out of the form by default,
      // except what a save cannot do without.
      if (!wanted) {
        if (coded.strict && !field.primaryKey && !field.required) {
          marks.hidden = true;
        }
        if (marks.hidden) {
          fieldUi.set(field.name, marks);
        }
        return field;
      }
      if (wanted.type && wanted.type !== field.type) {
        notes.push(
          `"${collection.name}.${field.name}" is ${field.type} in the database but ${wanted.type} in the schema.`,
        );
      }
      if (wanted.label) marks.label = wanted.label;
      if (wanted.description) marks.description = wanted.description;
      if (wanted.widget) marks.widget = wanted.widget;
      if (wanted.hidden !== undefined) marks.hidden = wanted.hidden;
      fieldUi.set(field.name, marks);

      const next: FieldDefinition = { ...field };
      if (wanted.readOnly) {
        next.readOnly = true;
      }
      if (wanted.required === true) {
        next.required = true;
      } else if (wanted.required === false && field.required) {
        notes.push(`"${collection.name}.${field.name}" stays required: the database requires it.`);
      }
      const validation: FieldValidation = { ...(field.validation ?? {}) };
      const tighten = (key: 'min' | 'minLength', value: number | undefined) => {
        if (value !== undefined) {
          validation[key] = Math.max(value, validation[key] ?? value);
        }
      };
      const loosen = (key: 'max' | 'maxLength', value: number | undefined) => {
        if (value !== undefined) {
          validation[key] = Math.min(value, validation[key] ?? value);
        }
      };
      tighten('min', wanted.min);
      tighten('minLength', wanted.minLength);
      loosen('max', wanted.max);
      loosen('maxLength', wanted.maxLength);
      if (wanted.options) {
        const existing = field.validation?.enum;
        validation.enum = existing
          ? wanted.options.filter((option) => existing.includes(option))
          : wanted.options;
        if (validation.enum.length === 0) {
          notes.push(`"${collection.name}.${field.name}" options leave no value the database allows.`);
        }
      }
      if (Object.keys(validation).length > 0) {
        next.validation = validation;
      }
      return next;
    });
    const entry: CollectionUi = { fields: fieldUi };
    if (coded.title) entry.title = coded.title;
    if (coded.titleField && present.has(coded.titleField)) {
      entry.titleField = coded.titleField;
    }
    ui.set(collection.name, entry);
    return { ...collection, fields };
  });
  return { collections, ui, notes };
}
