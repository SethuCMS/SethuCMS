/**
 * Turn a migration request into a checked plan with both databases open.
 * A dry run and a real run work from the same result.
 */
import { errors } from '@sethucms/core';
import {
  LIMITS,
  deriveTarget,
  orderByReferences,
  planCollection,
  type CollectionSpec,
  type MigrationPlan,
  type MigrationRequest,
} from './plan.js';

import { count, codeAndMessage } from './manager-helpers.js';
import type { MigrationDeps, Prepared } from './manager-types.js';

// Shared by plan and start. Reads both schemas, orders collections so
// referenced ones come first, plans each one, and optionally counts rows.
export async function prepareMigration(
  deps: MigrationDeps,
  request: MigrationRequest,
  withCounts: boolean,
) {
  const source = await deps.registry.raw(request.source);
  const target = await deps.registry.raw(request.target);

  const sourceDefs = new Map(
    source.discovered.map((collection) => [collection.name, collection]),
  );
  const targetDefs = new Map(
    target.discovered.map((collection) => [collection.name, collection]),
  );
  // Optional adapter abilities are feature-detected, not assumed.
  const creatable = typeof target.adapter.createCollection === 'function';
  const canFinish = typeof target.adapter.finishBulkLoad === 'function';

  const wanted: CollectionSpec[] =
    request.collections === 'all'
      ? source.discovered.map((collection) => ({
          from: collection.name,
          to: collection.name,
          fields: {},
        }))
      : request.collections;
  if (wanted.length === 0) {
    throw errors.validation('The source has no collections to copy');
  }

  const { ordered, cyclic } = orderByReferences(wanted, sourceDefs);
  const plan: MigrationPlan = {
    source: {
      id: source.connection.id,
      name: source.connection.name,
      adapter: source.connection.adapterType,
    },
    target: {
      id: target.connection.id,
      name: target.connection.name,
      adapter: target.connection.adapterType,
    },
    collections: [],
    problems: [],
    warnings: [],
    ready: false,
  };
  if (target.connection.mode !== 'read_write') {
    plan.warnings.push(
      'The target connection is read-only. Switch it to read-write before starting',
    );
  }

  const selectedFrom = new Set(ordered.map((spec) => spec.from));

  // Collections the target lacks: what would be created, so the plan can
  // check the copy against it.
  const specs = new Map(ordered.map((spec) => [spec.from, spec]));
  const toCreate = new Set<string>();
  if (request.createMissing) {
    const renamed = new Map<string, string>();
    for (const spec of ordered) {
      if (!targetDefs.has(spec.to) && sourceDefs.has(spec.from)) {
        renamed.set(spec.from, spec.to);
      }
    }
    for (const spec of ordered) {
      const sourceDef = sourceDefs.get(spec.from);
      if (!sourceDef || targetDefs.has(spec.to)) {
        continue;
      }
      try {
        targetDefs.set(
          spec.to,
          deriveTarget(spec, sourceDef, renamed, sourceDefs),
        );
        toCreate.add(spec.from);
      } catch {
        // left missing: the plan reports it below
      }
    }
  }

  for (const spec of ordered) {
    const willCreate = toCreate.has(spec.from);
    const entry = planCollection(
      spec,
      sourceDefs.get(spec.from),
      targetDefs.get(spec.to),
      request.dropUnmappedFields,
      request.preserveIds || willCreate,
      sourceDefs,
      willCreate,
      canFinish,
    );
    if (willCreate) {
      if (!creatable) {
        entry.problems.push(
          'This target database type cannot create collections from here. Create them yourself, then plan again',
        );
      } else {
        entry.warnings.push(
          `"${spec.to}" does not exist in the target and will be created, with the same fields and key. Indexes, defaults and rules other than types and required fields are not copied`,
        );
      }
      const approximate = (sourceDefs.get(spec.from)?.fields ?? []).some(
        (field) => field.type === 'array' || field.type === 'geopoint',
      );
      if (
        approximate &&
        ['postgres', 'mysql', 'sqlite'].includes(
          target.connection.adapterType,
        )
      ) {
        entry.warnings.push(
          'Array and geopoint fields are stored as JSON in this database',
        );
      }
    }

    const sourceDef = sourceDefs.get(spec.from);
    if (sourceDef) {
      // A reference to a collection that is not being copied keeps its old
      // value in the target.
      for (const copy of entry.fields) {
        if (copy.references && !selectedFrom.has(copy.references)) {
          entry.warnings.push(
            `"${copy.from}" points at "${copy.references}", which is not part of this migration; the values are copied as they are`,
          );
        }
      }
    }
    if (cyclic.includes(spec.from) && !entry.idsPreserved) {
      entry.problems.push(
        'This collection is part of a reference cycle and the target renumbers records, so references cannot be rewritten',
      );
    }
    if (
      withCounts &&
      sourceDef &&
      targetDefs.get(spec.to) &&
      entry.problems.length === 0
    ) {
      entry.sourceRecords = await count(
        source.adapter,
        sourceDef,
        LIMITS.planCountCap,
      );
      entry.targetRecords = willCreate
        ? { count: 0, exact: true }
        : await count(
            target.adapter,
            targetDefs.get(spec.to)!,
            LIMITS.planCountCap,
          );
    } else if (
      !withCounts &&
      sourceDef &&
      targetDefs.get(spec.to) &&
      !entry.idsPreserved &&
      !willCreate
    ) {
      entry.targetRecords = await count(
        target.adapter,
        targetDefs.get(spec.to)!,
        1,
      );
    }
    plan.collections.push(entry);
  }
  if (cyclic.length > 0) {
    plan.warnings.push(
      `These collections point at each other, so they cannot be ordered: ${cyclic.join(', ')}`,
    );
  }

  if (request.collections !== 'all') {
    const missing = request.collections
      .filter((spec) => !sourceDefs.has(spec.from))
      .map((spec) => spec.from);
    if (missing.length > 0) {
      plan.problems.push(`Not found in the source: ${missing.join(', ')}`);
    }
  }
  plan.ready =
    plan.problems.length === 0 &&
    plan.collections.every((collection) => collection.problems.length === 0);
  return { plan, source, target, sourceDefs, targetDefs, specs, toCreate };
}

// ---- Running --------------------------------------------------------
