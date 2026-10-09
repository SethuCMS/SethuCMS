/**
 * Reading and writing records through the guarded adapter.
 *
 * Every operation follows the same order:
 *   1. work out what the caller may do (permissions)
 *   2. restrict the query / check the fields
 *   3. run it through the GuardedAdapter (validation, read-only, timeouts)
 *   4. remove what the caller may not see
 *   5. audit and announce the change
 */
import {
  assertWritable,
  diffRecords,
  errors,
  parseQuery,
  primaryKeyOf,
  restrictQuery,
  type CollectionDefinition,
} from '@sethucms/core';
import type { Principal } from '../auth.js';
import type { AuditLog } from '../audit.js';
import type { ConnectionRegistry } from '../connections/registry.js';
import type { EventBus } from '../events.js';
import {
  accessFor,
  idValue,
  isRecordInScope,
  rejectUnknownFields,
  tryReadAccess,
  visibleRecord,
} from './access.js';

// Allow-list of query parameters; anything else is rejected, not ignored.
const LIST_PARAMS = new Set(['filter', 'sort', 'fields', 'limit', 'cursor']);
// Bound the JSON filter text before parsing it.
const MAX_FILTER_TEXT = 8192;

/** A page of records plus paging info and notes about adapter limits. */
export interface ListOutcome {
  data: Array<Record<string, unknown>>;
  page: { nextCursor: string | null; limit: number };
  meta: { capabilityNotes: string[] };
}

/**
 * Record reads and writes for a signed-in caller.
 *
 * Each method resolves the caller's permissions first and returns only
 * what they may see. Writes are audited and announced on the event bus.
 */
export class RecordsService {
  /**
   * @param registry Looks up open connections.
   * @param audit Receives an entry for every write.
   * @param events Notifies live streams and the change feed.
   */
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
  ) {}

  /**
   * List records of a collection.
   *
   * @param params URL query: `filter` (JSON), `sort`, `fields`, `limit`,
   *   `cursor`.
   * @throws A validation error for unknown or malformed parameters, and a
   *   forbidden error if the caller cannot read the collection.
   */
  async list(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    params: URLSearchParams,
  ): Promise<ListOutcome> {
    const bound = await this.registry.bind(connectionId);
    const collection = bound.model.require(collectionName);
    const access = accessFor(principal, collection, 'read');

    // Narrow the caller's query to their allowed fields and rows before it
    // reaches the database; the client never controls those limits.
    const query = restrictQuery(
      parseQuery(rawQueryFrom(collection.name, params)),
      access,
    );
    const page = await bound.guarded.find(query);

    return {
      data: page.records.map((record) =>
        visibleRecord(principal, collection, record),
      ),
      page: { nextCursor: page.nextCursor, limit: query.page.limit },
      meta: { capabilityNotes: page.notes },
    };
  }

  /**
   * Fetch one record.
   *
   * @throws Not found if the record is missing or outside the caller's rows
   *   (the same error, so row rules do not reveal that a record exists).
   */
  async get(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    const bound = await this.registry.bind(connectionId);
    const collection = bound.model.require(collectionName);
    const access = accessFor(principal, collection, 'read');

    if (
      access.rowFilter &&
      !(await isRecordInScope(bound, collection, access, id))
    ) {
      throw errors.notFound('Record not found');
    }
    const record = await bound.guarded.get(collection.name, id);
    return visibleRecord(principal, collection, record);
  }

  /**
   * Create a record.
   *
   * @param values Field values to store (unknown fields are rejected).
   * @param requestId Id of the HTTP request, for the audit trail.
   * @param via Audit operation name; drafts pass their own when publishing.
   * @returns The created record, as the caller may see it.
   * @throws Forbidden if the role cannot create or has row-level rules.
   */
  async create(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    values: unknown,
    requestId: string,
    via = 'record.create',
  ) {
    const bound = await this.registry.bind(connectionId);
    const collection = bound.model.require(collectionName);
    const access = accessFor(principal, collection, 'create');
    // A row rule cannot be checked before a record exists, so refuse rather
    // than guess.
    if (access.rowFilter) {
      throw errors.forbidden(
        'Creating records is not available with row-level rules',
      );
    }
    rejectUnknownFields(collection, values);
    assertWritable(values, access);

    const created = await bound.guarded.create(collection.name, values);
    const id = String(created[primaryKeyOf(collection).name]);
    this.audit.record({
      actor: principal.id,
      operation: via,
      target: `${connectionId}/${collectionName}/${id}`,
      requestId,
      detail: diffRecords(null, created),
    });
    this.events.publish({
      type: 'record.created',
      connectionId,
      collection: collectionName,
      recordId: id,
    });
    return visibleRecord(principal, collection, created);
  }

  /**
   * Update fields of a record.
   *
   * @param via Audit operation name; drafts pass their own when publishing.
   * @returns The updated record, as the caller may see it.
   * @throws Not found if missing or outside the caller's rows.
   */
  async update(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    id: string,
    values: unknown,
    requestId: string,
    via = 'record.update',
  ) {
    const bound = await this.registry.bind(connectionId);
    const collection = bound.model.require(collectionName);
    const access = accessFor(principal, collection, 'update');
    rejectUnknownFields(collection, values);
    assertWritable(values, access);
    if (
      access.rowFilter &&
      !(await isRecordInScope(bound, collection, access, id))
    ) {
      throw errors.notFound('Record not found');
    }

    // Read the old value first so the audit entry records a before/after diff.
    const before = await bound.guarded.get(collection.name, id);
    const updated = await bound.guarded.update(collection.name, id, values);
    this.audit.record({
      actor: principal.id,
      operation: via,
      target: `${connectionId}/${collectionName}/${id}`,
      requestId,
      detail: diffRecords(before, updated),
    });
    this.events.publish({
      type: 'record.updated',
      connectionId,
      collection: collectionName,
      recordId: id,
    });
    return visibleRecord(principal, collection, updated);
  }

  /** Delete a record. Not found if missing or outside the caller's rows. */
  async delete(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    id: string,
    requestId: string,
  ): Promise<void> {
    const bound = await this.registry.bind(connectionId);
    const collection = bound.model.require(collectionName);
    const access = accessFor(principal, collection, 'delete');
    if (
      access.rowFilter &&
      !(await isRecordInScope(bound, collection, access, id))
    ) {
      throw errors.notFound('Record not found');
    }

    const before = await bound.guarded.get(collection.name, id);
    await bound.guarded.delete(collection.name, id);
    this.audit.record({
      actor: principal.id,
      operation: 'record.delete',
      target: `${connectionId}/${collectionName}/${id}`,
      requestId,
      detail: diffRecords(before, null),
    });
    this.events.publish({
      type: 'record.deleted',
      connectionId,
      collection: collectionName,
      recordId: id,
    });
  }

  /**
   * The stored record with no masking, for comparing against drafts. Never sent
   * to clients as-is.
   */
  async rawGet(
    connectionId: string,
    collectionName: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    const bound = await this.registry.bind(connectionId);
    return bound.guarded.get(bound.model.require(collectionName).name, id);
  }

  /** True if the caller may read the collection at all. */
  readable(principal: Principal, collection: CollectionDefinition): boolean {
    return tryReadAccess(principal, collection) !== null;
  }

  /** Convert a URL id to the collection's primary key type. */
  coerceId(collection: CollectionDefinition, id: string): string | number {
    return idValue(collection, id);
  }
}

/** Turn URL parameters into the portable query format. */
// Repeated keys are rejected: which value wins would differ between
// parsers, a classic way to slip past a filter.
function rawQueryFrom(
  collection: string,
  params: URLSearchParams,
): Record<string, unknown> {
  for (const key of params.keys()) {
    if (!LIST_PARAMS.has(key)) {
      throw errors.validation(`Unknown query parameter: ${key.slice(0, 40)}`);
    }
  }
  if ([...params.keys()].length !== new Set(params.keys()).size) {
    throw errors.validation('Repeated query parameters are not allowed');
  }

  const raw: Record<string, unknown> = { collection };

  // Filter arrives as JSON text; `parseQuery` validates its shape later.
  const filter = params.get('filter');
  if (filter) {
    if (filter.length > MAX_FILTER_TEXT) {
      throw errors.validation('filter is too long');
    }
    try {
      raw['filter'] = JSON.parse(filter);
    } catch {
      throw errors.validation('filter must be valid JSON');
    }
  }

  const sort = params.get('sort');
  if (sort) {
    raw['sort'] = sort
      .split(',')
      .map((part) =>
        part.startsWith('-')
          ? { field: part.slice(1), dir: 'desc' }
          : { field: part, dir: 'asc' },
      );
  }

  const fields = params.get('fields');
  if (fields) {
    raw['projection'] = fields.split(',');
  }

  const page: Record<string, unknown> = {};
  const limit = params.get('limit');
  if (limit !== null) {
    // Digits only, so values like "1e9" or "-1" cannot reach the page size.
    if (!/^\d{1,4}$/.test(limit)) {
      throw errors.validation('limit must be a whole number');
    }
    page['limit'] = Number(limit);
  }
  const cursor = params.get('cursor');
  if (cursor) {
    page['cursor'] = cursor;
  }
  if (Object.keys(page).length > 0) {
    raw['page'] = { limit: 50, ...page };
  }

  return raw;
}
