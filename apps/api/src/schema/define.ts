/**
 * Helpers for writing a schema file. They only give you types and editor
 * hints; they return what you pass in, so a plain object works just as well.
 *
 *   import { defineSchema, defineCollection, defineField } from '.../schema/define.js';
 *   export default defineSchema([
 *     defineCollection({ name: 'certificates', fields: [defineField({ name: 'title' })] }),
 *   ]);
 */

export type Widget = 'text' | 'textarea' | 'code' | 'image' | 'file';

/** How the admin shows one field. Nothing here changes the database. */
export interface FieldSchema {
  name: string;
  /** What the database stores. Used to warn when the code and database disagree. */
  type?: string;
  label?: string;
  description?: string;
  /** Which editor to use: `code` for JSON, `image`/`file` for upload values. */
  widget?: Widget;
  /** Hide the field from the form by default (a person can still show it). */
  hidden?: boolean;
  /** Clients can read the field but not change it; enforced by the gateway. */
  readOnly?: boolean;
  /** Can only be turned on: the gateway never relaxes the database's own rules. */
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  /** The only values the field accepts. */
  options?: Array<string | number>;
}

export interface CollectionSchema {
  name: string;
  title?: string;
  /** The field used as the record's title in lists and search. */
  titleField?: string;
  /** Show only the fields listed here (others are hidden by default). */
  strict?: boolean;
  fields?: FieldSchema[];
}

export interface SchemaFile {
  collections: CollectionSchema[];
}

export function defineField<T extends FieldSchema>(field: T): T {
  return field;
}

export function defineCollection<T extends CollectionSchema>(collection: T): T {
  return collection;
}

export function defineSchema(
  input: CollectionSchema[] | SchemaFile,
): SchemaFile {
  return Array.isArray(input) ? { collections: input } : input;
}
