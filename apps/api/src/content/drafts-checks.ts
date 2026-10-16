/**
 * Checks on draft values and permissions that need no service state.
 */
import {
  assertWritable,
  errors,
  isPlainObject,
  validateRecord,
  throwIfIssues,
  type CollectionDefinition,
} from '@sethucms/core';
import type { Principal } from '../auth.js';
import type { StoredDraft } from '../store/state.js';
import { accessFor, rejectUnknownFields } from './access.js';

import { KEEP_FINISHED_DAYS, MAX_VALUES_BYTES } from './drafts-types.js';

/** Require update or create permission on the collection. */
export function assertCanEdit(
  principal: Principal,
  collection: CollectionDefinition,
): void {
  try {
    accessFor(principal, collection, 'update');
  } catch {
    accessFor(principal, collection, 'create');
  }
}

/**
 * Validate draft values: object shape, size, known fields, writable
 * fields and type rules. Missing required fields are allowed (see below).
 */
export function checkValues(
  collection: CollectionDefinition,
  values: unknown,
  access: ReturnType<typeof accessFor>,
  mode: 'create' | 'update',
): void {
  if (!isPlainObject(values)) {
    throw errors.validation('values must be an object');
  }
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_VALUES_BYTES) {
    throw errors.validation('Draft is too large');
  }
  rejectUnknownFields(collection, values);
  assertWritable(values, access);
  // Drafts may be incomplete: check the values that are present, not the ones
  // still missing.
  const issues = validateRecord(collection, values, mode).filter(
    (issue) =>
      !(
        issue.message === 'is required' && !Object.hasOwn(values, issue.path)
      ),
  );
  throwIfIssues(issues, 'Invalid draft values');
}

/** Drop published/discarded drafts older than the retention period. */
export function pruneFinished(drafts: Record<string, StoredDraft>): void {
  const cutoff = Date.now() - KEEP_FINISHED_DAYS * 86_400_000;
  for (const [id, draft] of Object.entries(drafts)) {
    if (
      (draft.status === 'published' || draft.status === 'discarded') &&
      Date.parse(draft.updatedAt) < cutoff
    ) {
      delete drafts[id];
    }
  }
}
