/**
 * Migration planning: work out, without writing anything, whether the data in
 * one connection can be copied into another, and what would be lost or changed.
 *
 * A plan is honest about three things:
 *   - blocking problems (the run is refused until they are fixed),
 *   - warnings (the run is allowed, but the person should know), and
 *   - how ids are handled (kept as they are, or renumbered by the target).
 */
import {
  defineCollection,
  errors,
  isPlainObject,
  primaryKeyOf,
  referencedCollection as referenceOf,
  type CollectionDefinition,
  type FieldDefinition,
} from '@sethucms/core';

/**
 * What to do when a record with the same id already exists in the target:
 * leave it (`skip`), replace it (`overwrite`) or stop the run (`fail`).
 */
export type ConflictPolicy = 'skip' | 'overwrite' | 'fail';

/** Which source collection goes to which target collection, with renames. */
export interface CollectionSpec {
  /** Collection name in the source connection. */
  from: string;
  /** Collection name in the target connection. Defaults to the same name. */
  to: string;
  /**
   * Explicit renames: source field -> target field. Unlisted fields keep their
   * name.
   */
  fields: Record<string, string>;
}

/** A validated migration request. Build it with `parseMigrationRequest`. */
export interface MigrationRequest {
  source: string;
  target: string;
  collections: CollectionSpec[] | 'all';
  onConflict: ConflictPolicy;
  batchSize: number;
  maxRecords: number;
  maxErrors: number;
  verify: boolean;
  /** Allow source fields that have no home in the target to be left behind. */
  dropUnmappedFields: boolean;
  /**
   * Write the original ids even when the target normally numbers its own
   * records.
   */
  preserveIds: boolean;
  /**
   * Create collections the target does not have yet (with the same fields),
   * then copy into them.
   */
  createMissing: boolean;
}

/** Hard caps on request size, so one migration cannot run unbounded. */
export const LIMITS = {
  maxCollections: 100,
  maxBatch: 500,
  defaultBatch: 100,
  defaultMaxRecords: 1_000_000,
  hardMaxRecords: 50_000_000,
  defaultMaxErrors: 100,
  planCountCap: 100_000,
} as const;

// Allow-lists of accepted keys. Unknown keys are rejected rather than
// ignored, so a typo like "dropUnmapedFields" fails instead of silently
// using the default.
const REQUEST_KEYS = [
  'source',
  'target',
  'collections',
  'onConflict',
  'batchSize',
  'maxRecords',
  'maxErrors',
  'verify',
  'dropUnmappedFields',
  'preserveIds',
  'createMissing',
];
const SPEC_KEYS = ['from', 'to', 'fields'];
// Plain identifiers only: names later reach adapters and error messages.
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Turn untrusted JSON into a validated request. */
export function parseMigrationRequest(input: unknown): MigrationRequest {
  if (!isPlainObject(input)) {
    throw errors.validation('Body must be a JSON object');
  }
  for (const key of Object.keys(input)) {
    if (!REQUEST_KEYS.includes(key)) {
      throw errors.validation(`Unknown setting: ${key.slice(0, 40)}`);
    }
  }

  const source = text(input['source'], 'source');
  const target = text(input['target'], 'target');
  // Copying a connection into itself could duplicate or destroy data.
  if (source === target) {
    throw errors.validation('source and target must be different connections');
  }

  let collections: MigrationRequest['collections'] = 'all';
  const raw = input['collections'];
  if (raw !== undefined && raw !== 'all') {
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > LIMITS.maxCollections
    ) {
      throw errors.validation(
        `collections must be "all" or a list of 1 to ${LIMITS.maxCollections} items`,
      );
    }
    // Each source and each target may appear once; two sources writing into
    // one target collection would interleave and clash.
    const seenFrom = new Set<string>();
    const seenTo = new Set<string>();
    collections = raw.map((item, index) => {
      const spec = parseSpec(item, index);
      if (seenFrom.has(spec.from)) {
        throw errors.validation(
          `collections[${index}]: "${spec.from}" is listed twice`,
        );
      }
      if (seenTo.has(spec.to)) {
        throw errors.validation(
          `collections[${index}]: two collections would be copied into "${spec.to}"`,
        );
      }
      seenFrom.add(spec.from);
      seenTo.add(spec.to);
      return spec;
    });
  }

  // Defaults are the cautious choices: skip conflicts, verify, and never
  // drop fields or force ids unless asked.
  const onConflict = input['onConflict'] ?? 'skip';
  if (
    onConflict !== 'skip' &&
    onConflict !== 'overwrite' &&
    onConflict !== 'fail'
  ) {
    throw errors.validation('onConflict must be "skip", "overwrite" or "fail"');
  }

  return {
    source,
    target,
    collections,
    onConflict,
    batchSize: int(
      input['batchSize'],
      'batchSize',
      1,
      LIMITS.maxBatch,
      LIMITS.defaultBatch,
    ),
    maxRecords: int(
      input['maxRecords'],
      'maxRecords',
      1,
      LIMITS.hardMaxRecords,
      LIMITS.defaultMaxRecords,
    ),
    maxErrors: int(
      input['maxErrors'],
      'maxErrors',
      1,
      10_000,
      LIMITS.defaultMaxErrors,
    ),
    verify: bool(input['verify'], 'verify', true),
    dropUnmappedFields: bool(
      input['dropUnmappedFields'],
      'dropUnmappedFields',
      false,
    ),
    preserveIds: bool(input['preserveIds'], 'preserveIds', false),
    createMissing: bool(input['createMissing'], 'createMissing', false),
  };
}

/** Validate one `collections` entry (a name, or `{ from, to, fields }`). */
function parseSpec(item: unknown, index: number): CollectionSpec {
  const where = `collections[${index}]`;
  if (typeof item === 'string') {
    return { from: name(item, where), to: name(item, where), fields: {} };
  }
  if (!isPlainObject(item)) {
    throw errors.validation(`${where} must be a name or an object`);
  }
  for (const key of Object.keys(item)) {
    if (!SPEC_KEYS.includes(key)) {
      throw errors.validation(`${where}: unknown setting ${key.slice(0, 40)}`);
    }
  }
  const from = name(item['from'], `${where}.from`);
  const to = item['to'] === undefined ? from : name(item['to'], `${where}.to`);
  const fields: Record<string, string> = {};
  if (item['fields'] !== undefined) {
    if (!isPlainObject(item['fields'])) {
      throw errors.validation(
        `${where}.fields must be an object of source -> target names`,
      );
    }
    // Cap the mapping size and forbid two fields mapping to one target.
    const entries = Object.entries(item['fields']);
    if (entries.length > 500) {
      throw errors.validation(`${where}.fields is too long`);
    }
    const targets = new Set<string>();
    for (const [sourceField, targetField] of entries) {
      name(sourceField, `${where}.fields key`);
      const mapped = name(
        targetField,
        `${where}.fields.${sourceField.slice(0, 40)}`,
      );
      if (targets.has(mapped)) {
        throw errors.validation(
          `${where}.fields: two fields map to "${mapped}"`,
        );
      }
      targets.add(mapped);
      fields[sourceField] = mapped;
    }
  }
  return { from, to, fields };
}

/** Require a plain identifier (see NAME). */
function name(value: unknown, where: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw errors.validation(
      `${where} must be a plain name (letters, digits, underscore)`,
    );
  }
  return value;
}
/** Require a short single-line string (a connection id). */
function text(value: unknown, where: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 80 ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw errors.validation(`${where} is required`);
  }
  return value;
}
/** Optional whole number within [min, max]; `fallback` if absent. */
function int(
  value: unknown,
  where: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw errors.validation(
      `${where} must be a whole number from ${min} to ${max}`,
    );
  }
  return value;
}
/** Optional boolean; `fallback` if absent. */
function bool(value: unknown, where: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw errors.validation(`${where} must be true or false`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** One field that will be copied, with its target name and type. */
export interface FieldCopy {
  from: string;
  to: string;
  type: string;
  /** Set when the source field points at another collection. */
  references?: string;
}

/** The dry-run result for one collection. */
export interface CollectionPlan {
  from: string;
  to: string;
  /** Fields that will be copied. */
  fields: FieldCopy[];
  /** Source fields with nowhere to go (their values are not copied). */
  leftBehind: string[];
  /** Target fields that will not be written, with the reason. */
  notWritten: Array<{ field: string; reason: string }>;
  /**
   * True when record ids are copied as they are. False when the target assigns
   * new ids.
   */
  idsPreserved: boolean;
  /**
   * True when the target collection does not exist yet and will be created
   * before copying.
   */
  create: boolean;
  /** Blocking problems. The run is refused while any exist. */
  problems: string[];
  warnings: string[];
  sourceRecords: { count: number; exact: boolean } | null;
  targetRecords: { count: number; exact: boolean } | null;
}

/** The dry-run result for a whole migration. */
export interface MigrationPlan {
  source: { id: string; name: string; adapter: string };
  target: { id: string; name: string; adapter: string };
  /** In the order they will be copied: referenced collections first. */
  collections: CollectionPlan[];
  problems: string[];
  warnings: string[];
  /** True when nothing blocks the run. */
  ready: boolean;
}

/**
 * Types that can hold each other's values. The per-record check catches any
 * single bad value.
 */
const COMPATIBLE: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['string', 'text']),
  new Set(['json', 'array']),
  new Set(['reference', 'string', 'integer']),
];
/** An integer always fits in a decimal; the reverse can lose data. */
const WIDENS: ReadonlyArray<[string, string]> = [['integer', 'decimal']];

/**
 * Can values of `source` type go into a `target` field?
 *
 * @returns `same`; `check` (may fit, each value is verified during the
 *   copy); or `no` (blocked, the types cannot hold each other's values).
 */
export function typesCompatible(
  source: string,
  target: string,
): 'same' | 'check' | 'no' {
  if (source === target) {
    return 'same';
  }
  if (WIDENS.some(([from, to]) => from === source && to === target)) {
    return 'check';
  }
  if (COMPATIBLE.some((group) => group.has(source) && group.has(target))) {
    return 'check';
  }
  return 'no';
}

/** Decide how one collection maps onto another. Pure: no database calls. */
// Walks every source field and decides: copy, leave behind, or skip with a
// reason. Anything that could lose or corrupt data becomes a `problem`
// (blocks the run); anything merely surprising becomes a `warning`.
export function planCollection(
  spec: CollectionSpec,
  source: CollectionDefinition | undefined,
  target: CollectionDefinition | undefined,
  dropUnmappedFields: boolean,
  preserveIds = false,
  allSources: ReadonlyMap<string, CollectionDefinition> = new Map(),
  /**
   * The target collection will be created by the migration, so its ids are
   * always kept and its counter is moved afterwards.
   */
  willCreate = false,
  /**
   * Whether the target adapter can move its id counter itself after a bulk
   * load.
   */
  canFinishBulkLoad = false,
): CollectionPlan {
  const plan: CollectionPlan = {
    from: spec.from,
    to: spec.to,
    fields: [],
    leftBehind: [],
    notWritten: [],
    idsPreserved: true,
    create: willCreate,
    problems: [],
    warnings: [],
    sourceRecords: null,
    targetRecords: null,
  };
  if (!source) {
    plan.problems.push(`The source has no collection called "${spec.from}"`);
    return plan;
  }
  if (!target) {
    plan.problems.push(
      `The target has no collection called "${spec.to}". Create the table or collection there first, then plan again`,
    );
    return plan;
  }

  const sourceFields = new Map(
    source.fields.map((field) => [field.name, field]),
  );
  for (const key of Object.keys(spec.fields)) {
    if (!sourceFields.has(key)) {
      plan.problems.push(
        `Field "${key}" does not exist in the source collection`,
      );
    }
  }
  const targetFields = new Map(
    target.fields.map((field) => [field.name, field]),
  );
  for (const mapped of Object.values(spec.fields)) {
    if (!targetFields.has(mapped)) {
      plan.problems.push(
        `Field "${mapped}" does not exist in the target collection`,
      );
    }
  }

  const sourceKey = primaryKeyOf(source);
  const targetKey = primaryKeyOf(target);
  const covered = new Set<string>();

  for (const field of source.fields) {
    const to = spec.fields[field.name] ?? field.name;
    const destination = targetFields.get(to);
    if (!destination) {
      plan.leftBehind.push(field.name);
      continue;
    }
    const isTargetKey = destination.name === targetKey.name;
    // Admin asked to keep original ids even though the target numbers its own.
    if (isTargetKey && targetKey.generated && preserveIds) {
      const fit = typesCompatible(field.type, destination.type);
      if (fit === 'no') {
        plan.problems.push(
          `"${field.name}" is ${field.type} but the target key "${destination.name}" is ${destination.type}; the original ids cannot be kept`,
        );
      } else {
        plan.fields.push({
          from: field.name,
          to: destination.name,
          type: destination.type,
          ...(referenceOf(source, field, allSources)
            ? { references: referenceOf(source, field, allSources)! }
            : {}),
        });
        if (!canFinishBulkLoad) {
          plan.warnings.push(
            `The original ids are written into "${destination.name}", which the target normally numbers itself. Afterwards, move the target's counter past the largest id, or new records may collide`,
          );
        }
      }
      covered.add(destination.name);
      continue;
    }
    if (isTargetKey && targetKey.generated) {
      // The target numbers its own records; the source key is only used to
      // rewrite references.
      plan.idsPreserved = false;
      plan.notWritten.push({
        field: destination.name,
        reason: 'the target assigns this id itself',
      });
      covered.add(destination.name);
      continue;
    }
    const blockReason = notWritable(destination);
    if (blockReason) {
      plan.notWritten.push({ field: destination.name, reason: blockReason });
      covered.add(destination.name);
      if (!destination.generated) {
        plan.warnings.push(
          `"${field.name}" is copied from the source but "${destination.name}" is ${blockReason}, so the value is not copied`,
        );
      }
      continue;
    }
    const fit = typesCompatible(field.type, destination.type);
    if (fit === 'no') {
      plan.problems.push(
        `"${field.name}" is ${field.type} but "${destination.name}" is ${destination.type}; they cannot hold each other's values`,
      );
      continue;
    }
    if (fit === 'check') {
      plan.warnings.push(
        `"${field.name}" (${field.type}) goes into "${destination.name}" (${destination.type}); each value is checked and records that do not fit are reported`,
      );
    }
    if (field.lossy || destination.lossy) {
      plan.warnings.push(
        `"${field.name}" may not survive the copy exactly (the database stores it approximately)`,
      );
    }
    if (field.required !== true && destination.required === true) {
      plan.warnings.push(
        `"${field.name}" is optional in the source but required in the target; records without a value will fail`,
      );
    }
    plan.fields.push({
      from: field.name,
      to: destination.name,
      type: destination.type,
      ...(referenceOf(source, field, allSources)
        ? { references: referenceOf(source, field, allSources)! }
        : {}),
    });
    covered.add(destination.name);
  }

  // Target fields nobody fills in.
  for (const field of target.fields) {
    if (covered.has(field.name)) {
      continue;
    }
    if (field.generated || field.readOnly) {
      plan.notWritten.push({
        field: field.name,
        reason: field.generated
          ? 'the target generates this value'
          : 'read-only in the target',
      });
    } else if (field.required) {
      plan.problems.push(
        `The target requires "${field.name}" but no source field fills it. Map one with "fields", or make it optional in the target`,
      );
    }
  }

  if (
    !plan.fields.some((copy) => copy.to === targetKey.name) &&
    plan.idsPreserved
  ) {
    plan.problems.push(
      `The target key "${targetKey.name}" is not filled by any source field; map the source key ("${sourceKey.name}") to it with "fields"`,
    );
  }
  if (plan.leftBehind.length > 0) {
    const message = `Not copied, no matching target field: ${plan.leftBehind.join(', ')}`;
    if (dropUnmappedFields) {
      plan.warnings.push(message);
    } else {
      plan.problems.push(
        `${message}. Map them with "fields", or set dropUnmappedFields to true to leave them behind`,
      );
    }
  }
  // With renumbering a re-run would insert everything again, hence the
  // "target must be empty" warning.
  if (!plan.idsPreserved) {
    plan.warnings.push(
      `The target numbers its own records, so new ids are assigned and references are rewritten. Running it a second time would create duplicates, so the target collection must be empty`,
    );
    if (plan.fields.some((copy) => copy.references === spec.from)) {
      plan.problems.push(
        'This collection points at itself and the target renumbers records, so those references cannot be rewritten safely. Use a target whose key is not generated',
      );
    }
  }
  if (source.relations.length > 0 || target.relations.length > 0) {
    plan.warnings.push(
      'Relations are not copied as such; only the fields that hold them are',
    );
  }
  return plan;
}

/**
 * The collection a migration would create in the target for this source
 * collection: same fields (renamed as asked), same key, references kept only
 * when the other collection is created too. Pure: nothing is written here.
 */
export function deriveTarget(
  spec: CollectionSpec,
  source: CollectionDefinition,
  copied: ReadonlyMap<string, string>,
  allSources: ReadonlyMap<string, CollectionDefinition>,
): CollectionDefinition {
  const fields = source.fields.map((field): FieldDefinition => {
    const name = spec.fields[field.name] ?? field.name;
    const { references: _references, lossy: _lossy, ...rest } = field;
    const other = referenceOf(source, field, allSources);
    if (field.type === 'reference' || other) {
      const renamed = other ? copied.get(other) : undefined;
      if (field.type === 'reference' && renamed) {
        return { ...rest, name, references: renamed };
      }
      // The other collection is not being created, so this is just a value of
      // the same kind as the other key.
      const otherKey = other ? allSources.get(other) : undefined;
      const type =
        field.type === 'reference'
          ? otherKey
            ? primaryKeyOf(otherKey).type
            : 'string'
          : field.type;
      return { ...rest, name, type: type === 'reference' ? 'string' : type };
    }
    return { ...rest, name };
  });
  return defineCollection({ name: spec.to, fields, relations: [] });
}

/** Why a target field cannot be written, or undefined if it can. */
function notWritable(field: FieldDefinition): string | undefined {
  if (field.generated) {
    return 'generated by the target';
  }
  if (field.readOnly) {
    return 'read-only in the target';
  }
  return undefined;
}

/**
 * Order collections so each one comes after the collections it points at. A
 * cycle cannot be ordered; its members are returned last, and the caller
 * reports it.
 */
// Kahn-style layering: repeatedly take collections whose dependencies are
// done. Whatever is left when none are ready is a cycle.
export function orderByReferences(
  specs: CollectionSpec[],
  sources: Map<string, CollectionDefinition>,
): { ordered: CollectionSpec[]; cyclic: string[] } {
  const selected = new Set(specs.map((spec) => spec.from));
  const needs = new Map<string, Set<string>>();
  for (const spec of specs) {
    const wanted = new Set<string>();
    const own = sources.get(spec.from);
    for (const field of own?.fields ?? []) {
      const target = own ? referenceOf(own, field, sources) : undefined;
      if (target && target !== spec.from && selected.has(target)) {
        wanted.add(target);
      }
    }
    needs.set(spec.from, wanted);
  }

  const ordered: CollectionSpec[] = [];
  const done = new Set<string>();
  let remaining = [...specs];
  while (remaining.length > 0) {
    const ready = remaining.filter((spec) =>
      [...(needs.get(spec.from) ?? [])].every((dep) => done.has(dep)),
    );
    if (ready.length === 0) {
      return {
        ordered: [...ordered, ...remaining],
        cyclic: remaining.map((spec) => spec.from),
      };
    }
    for (const spec of ready) {
      ordered.push(spec);
      done.add(spec.from);
    }
    remaining = remaining.filter((spec) => !done.has(spec.from));
  }
  return { ordered, cyclic: [] };
}
