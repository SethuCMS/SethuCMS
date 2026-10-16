/**
 * Small helpers the migration manager shares: counting, retrying, comparing.
 */
import type { Adapter } from '@sethucms/adapter-sdk';
import {
  canonicalJson,
  errors,
  isSethuError,
  primaryKeyOf,
  type CollectionDefinition,
} from '@sethucms/core';

import {
  CALL_TIMEOUT_MS,
  MAX_LISTED_ERRORS,
  RETRY_CODES,
  type JobError,
  type MigrationJob,
} from './manager-types.js';

/** Count records by reading pages of keys, up to `cap`. */
export async function count(
  adapter: Adapter,
  collection: CollectionDefinition,
  cap: number,
): Promise<{ count: number; exact: boolean }> {
  let position: unknown;
  let total = 0;
  for (;;) {
    const limit = Math.min(500, cap - total);
    if (limit <= 0) {
      return { count: total, exact: false };
    }
    const page = await withRetry(() =>
      adapter.find(
        collection,
        {
          collection: collection.name,
          projection: [primaryKeyOf(collection).name],
          page: { limit },
        },
        position,
      ),
    );
    total += page.records.length;
    if (page.nextPosition === undefined || page.records.length === 0) {
      return { count: total, exact: true };
    }
    if (total >= cap) {
      return { count: total, exact: false };
    }
    position = page.nextPosition;
  }
}

/**
 * Run one database call with a time limit, trying once more if the connection
 * hiccups.
 */
export async function withRetry<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await withTimeout(call());
  } catch (error) {
    if (!(isSethuError(error) && RETRY_CODES.has(error.code))) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return withTimeout(call());
  }
}

// Race against a timer so one hung database call cannot stall the job.
export function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(errors.timeout('The database took too long to answer')),
      CALL_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Do the stored values differ from what was sent? Compared field by field, the
 * way each type is meant to be compared: 10.5 and "10.50" are the same decimal,
 * and two spellings of the same moment are the same date-time.
 */
export function differs(
  target: CollectionDefinition,
  sent: Record<string, unknown>,
  stored: Record<string, unknown>,
): boolean {
  const types = new Map(target.fields.map((field) => [field.name, field.type]));
  return Object.entries(sent).some(
    ([field, value]) =>
      !sameValue(types.get(field), value ?? null, stored[field] ?? null),
  );
}

export function sameValue(
  type: string | undefined,
  sent: unknown,
  stored: unknown,
): boolean {
  if (sent === null || stored === null) {
    return sent === stored;
  }
  switch (type) {
    case 'decimal': {
      const a = Number(sent);
      const b = Number(stored);
      return Number.isFinite(a) && Number.isFinite(b) && a === b;
    }
    case 'datetime':
      return (
        typeof sent === 'string' &&
        typeof stored === 'string' &&
        Date.parse(sent) === Date.parse(stored)
      );
    case 'integer':
    case 'reference':
      return String(sent) === String(stored);
    default:
      return canonicalJson(stored) === canonicalJson(sent);
  }
}

/**
 * Turn an error into a code and a message safe to store and show.
 * Only known errors keep their text; anything else is masked, because
 * driver errors can contain values, hosts or credentials.
 */
export function codeAndMessage(error: unknown): { code: string; message: string } {
  if (isSethuError(error)) {
    return {
      code: error.code,
      message:
        error.code === 'INTERNAL'
          ? 'Unexpected error while writing this record'
          : error.message.slice(0, 300),
    };
  }
  return {
    code: 'INTERNAL',
    message: 'Unexpected error while writing this record',
  };
}

/** Short safe description of an error (see `codeAndMessage`). */
export function describe(error: unknown): string {
  return codeAndMessage(error).message;
}

// Keep only the first few errors in the job; the rest are just counted.
export function addError(
  job: MigrationJob,
  error: JobError,
  maxErrors: number,
): void {
  if (job.errors.length >= Math.min(maxErrors, MAX_LISTED_ERRORS)) {
    job.errorsTruncated = true;
    return;
  }
  job.errors.push(error);
}
