/**
 * Copy one collection, record by record, from the source to the target.
 */
import type { Adapter } from '@sethucms/adapter-sdk';
import {
  errors,
  isSethuError,
  primaryKeyOf,
  isValueOfType,
  validateRecord,
  type CollectionDefinition,
} from '@sethucms/core';
import type { Counter } from '../metrics.js';
import { type CollectionPlan, type MigrationRequest } from './plan.js';

import {
  addError,
  differs,
  sameValue,
  codeAndMessage,
  describe,
  withRetry,
} from './manager-helpers.js';
import type { CollectionProgress, JobError, Run } from './manager-types.js';

// Pages through the source with a cursor. Cancel is checked per record.
export async function copyCollection(
  records: Counter,
  run: Run,
  request: MigrationRequest,
  from: Adapter,
  to: Adapter,
  entry: CollectionPlan,
  progress: CollectionProgress,
  sourceDef: CollectionDefinition,
  targetDef: CollectionDefinition,
  idMaps: Map<string, Map<string, unknown>>,
  ownMap: Map<string, unknown>,
): Promise<void> {
  const sourceKey = primaryKeyOf(sourceDef).name;
  const targetKey = primaryKeyOf(targetDef).name;
  let position: unknown;
  let seen = 0;

  for (;;) {
    if (run.cancel) {
      return;
    }
    const page = await withRetry(() =>
      from.find(
        sourceDef,
        { collection: sourceDef.name, page: { limit: request.batchSize } },
        position,
      ),
    );

    for (const record of page.records) {
      if (run.cancel) {
        return;
      }
      if (seen >= request.maxRecords) {
        progress.note = `Stopped at the limit of ${request.maxRecords} records for this collection`;
        return;
      }
      seen += 1;
      progress.read += 1;
      const sourceId = String(record[sourceKey]);

      try {
        const outcome = await copyOne(
          request,
          to,
          entry,
          targetDef,
          targetKey,
          record,
          sourceId,
          idMaps,
          ownMap,
        );
        progress[outcome.result] += 1;
        records.inc({ result: outcome.result });
        if (outcome.different) {
          progress.differences += 1;
        }
      } catch (error) {
        progress.failed += 1;
        records.inc({ result: 'failed' });
        addError(
          run.job,
          { collection: entry.from, id: sourceId, ...codeAndMessage(error) },
          request.maxErrors,
        );
        if (
          request.onConflict === 'fail' &&
          isSethuError(error) &&
          error.code === 'CONFLICT'
        ) {
          return;
        }
        if (run.job.errors.length >= request.maxErrors) {
          return;
        }
      }
    }
    if (page.nextPosition === undefined || page.records.length === 0) {
      return;
    }
    position = page.nextPosition;
  }
}

// Copy a single record: map fields, rewrite references to renumbered ids,
// validate against the target's own rules, then apply the conflict policy.
export async function copyOne(
  request: MigrationRequest,
  to: Adapter,
  entry: CollectionPlan,
  targetDef: CollectionDefinition,
  targetKey: string,
  record: Record<string, unknown>,
  sourceId: string,
  idMaps: Map<string, Map<string, unknown>>,
  ownMap: Map<string, unknown>,
): Promise<{
  result: 'created' | 'updated' | 'skipped';
  different: boolean;
}> {
  const values: Record<string, unknown> = {};
  for (const copy of entry.fields) {
    let value = record[copy.from];
    if (value === undefined) {
      value = null;
    }
    const map = copy.references ? idMaps.get(copy.references) : undefined;
    if (map && value !== null) {
      if (!map.has(String(value))) {
        throw errors.validation(
          `"${copy.from}" points at ${copy.references}/${String(value)}, which was not copied`,
        );
      }
      value = map.get(String(value));
    }
    values[copy.to] = value;
  }

  // A generated key is not writable under the normal rules; with preserveIds
  // it is checked on its own.
  const keyField = targetDef.fields.find(
    (field) => field.name === targetKey,
  )!;
  const writesGeneratedKey =
    (request.preserveIds || entry.create) && keyField.generated === true;
  const { [targetKey]: keyValue, ...rest } = values;
  const issues = writesGeneratedKey
    ? [
        ...validateRecord(targetDef, rest, 'create'),
        ...(keyValue === null ||
        keyValue === undefined ||
        !isValueOfType(keyField.type, keyValue)
          ? [{ path: targetKey, message: `must be of type ${keyField.type}` }]
          : []),
      ]
    : validateRecord(targetDef, values, 'create');
  if (issues.length > 0) {
    throw errors.validation(
      issues
        .slice(0, 3)
        .map((issue) => `${issue.path || 'record'} ${issue.message}`)
        .join('; '),
    );
  }

  // Look before writing so `onConflict` is honoured (skip/fail/overwrite).
  if (entry.idsPreserved) {
    const targetId = String(values[targetKey]);
    const existing = await withRetry(() => to.get(targetDef, targetId));
    if (existing) {
      if (request.onConflict === 'skip') {
        return { result: 'skipped', different: false };
      }
      if (request.onConflict === 'fail') {
        throw errors.conflict(
          'A record with this id already exists in the target',
        );
      }
      const { [targetKey]: _key, ...changes } = values;
      const stored = await withRetry(() =>
        to.update(targetDef, targetId, changes),
      );
      return {
        result: 'updated',
        different: request.verify && differs(targetDef, values, stored),
      };
    }
  }

  const stored = await withRetry(() => to.create(targetDef, values));
  if (!entry.idsPreserved) {
    ownMap.set(sourceId, stored[targetKey]);
  } else if (
    // Some databases silently assign their own id; treat that as an error
    // rather than leave references pointing at the wrong rows.
    writesGeneratedKey &&
    String(stored[targetKey]) !== String(values[targetKey])
  ) {
    throw errors.conflict(
      'The target ignored the original id and numbered the record itself. This database cannot keep ids; turn preserveIds off',
    );
  }
  return {
    result: 'created',
    different: request.verify && differs(targetDef, values, stored),
  };
}
