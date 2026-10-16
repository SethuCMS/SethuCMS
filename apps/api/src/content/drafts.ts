/**
 * Drafts, publishing and preview.
 *
 * A draft is an edit that has NOT been written to the customer's database.
 * Drafts live in the gateway's own store (encrypted), so a half-finished
 * article never shows up in a production table. Publishing writes the draft's
 * values to the database through the normal guarded path.
 *
 * Two kinds of conflict are handled:
 *   - two editors saving the same draft: each save carries the `version` it
 *     started from, and a stale version is refused
 *   - someone changing the published record while a draft was open: the draft
 *     remembers a fingerprint of the record it started from, and publishing
 *     refuses (unless forced) when the record has changed since
 */
import { randomUUID } from 'node:crypto';
import {
  assertWritable,
  errors,
  isPlainObject,
  maskRecord,
  primaryKeyOf,
  type CollectionDefinition,
} from '@sethucms/core';
import type { Authenticator, Principal } from '../auth.js';
import type { AuditLog } from '../audit.js';
import type { ConnectionRegistry } from '../connections/registry.js';
import type { EventBus } from '../events.js';
import type { PreviewTokens } from '../security/preview-token.js';
import type { Vault } from '../security/vault.js';
import type { StateStore, StoredDraft } from '../store/state.js';
import {
  accessFor,
  isRecordInScope,
  tryReadAccess,
  visibleRecord,
} from './access.js';
import type { RecordsService } from './records.js';
import { assertCanEdit, checkValues, pruneFinished } from './drafts-checks.js';
import {
  MAX_ACTIVE_DRAFTS,
  PREVIEW_TTL_SECONDS,
  fingerprint,
  type DraftView,
} from './drafts-types.js';

export type { DraftView } from './drafts-types.js';

/**
 * Create, edit, discard and publish drafts, and serve signed previews.
 *
 * Draft values are encrypted at rest. Publishing goes through
 * `RecordsService`, so the usual permission, validation and audit rules
 * apply exactly as for a direct write.
 */
export class DraftsService {
  /** Takes the stores and helpers the service works with; no logic here. */
  constructor(
    private readonly store: StateStore,
    private readonly vault: Vault,
    private readonly registry: ConnectionRegistry,
    private readonly records: RecordsService,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
    private readonly previews: PreviewTokens,
    private readonly auth: Authenticator,
  ) {}

  // ---- Reading --------------------------------------------------------

  /**
   * List drafts of a collection, newest first.
   *
   * @param status `draft` (default), `published`, `discarded` or `all`.
   * @throws A validation error for an unknown status, forbidden if the
   *   caller cannot edit the collection.
   */
  async list(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    status: string | null,
  ): Promise<DraftView[]> {
    const collection = await this.collectionOf(connectionId, collectionName);
    assertCanEdit(principal, collection);
    const wanted = status ?? 'draft';
    if (!['draft', 'published', 'discarded', 'all'].includes(wanted)) {
      throw errors.validation(
        'status must be draft, published, discarded or all',
      );
    }

    return Object.values(this.store.read().drafts)
      .filter(
        (draft) =>
          draft.connectionId === connectionId &&
          draft.collection === collectionName &&
          (wanted === 'all' || draft.status === wanted),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((draft) => this.view(principal, collection, draft));
  }

  /** Fetch one draft. Not found if it belongs to another collection. */
  async get(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    draftId: string,
  ): Promise<DraftView> {
    const collection = await this.collectionOf(connectionId, collectionName);
    assertCanEdit(principal, collection);
    return this.view(
      principal,
      collection,
      this.find(connectionId, collectionName, draftId),
    );
  }

  // ---- Changing -------------------------------------------------------

  /**
   * Start a draft, either for a new record or on top of an existing one.
   *
   * @param body `{ recordId?, values? }`; anything else is rejected.
   * @param requestId Id of the HTTP request, for the audit trail.
   * @returns The new draft.
   * @throws Forbidden/not found per the caller's permissions and row rules;
   *   validation error for bad values or too many open drafts.
   */
  async create(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    body: unknown,
    requestId: string,
  ): Promise<DraftView> {
    const collection = await this.collectionOf(connectionId, collectionName);
    if (!isPlainObject(body)) {
      throw errors.validation('Body must be an object');
    }
    const unknown = Object.keys(body).filter(
      (key) => key !== 'recordId' && key !== 'values',
    );
    if (unknown.length > 0) {
      throw errors.validation(`Unknown field: ${unknown[0]?.slice(0, 40)}`);
    }

    const recordId =
      body['recordId'] === undefined || body['recordId'] === null
        ? null
        : String(body['recordId']);
    const values = body['values'] ?? {};
    // Drafting needs the same permission as the final write would.
    const access = accessFor(
      principal,
      collection,
      recordId ? 'update' : 'create',
    );
    if (!recordId && access.rowFilter) {
      throw errors.forbidden(
        'Creating records is not available with row-level rules',
      );
    }
    checkValues(
      collection,
      values,
      access,
      recordId ? 'update' : 'create',
    );

    let baseHash: string | null = null;
    if (recordId) {
      const bound = await this.registry.bind(connectionId);
      if (
        access.rowFilter &&
        !(await isRecordInScope(bound, collection, access, recordId))
      ) {
        throw errors.notFound('Record not found');
      }
      // Remember what the record looked like now, so publish can notice if
      // someone else changed it in the meantime.
      baseHash = fingerprint(
        await this.records.rawGet(connectionId, collectionName, recordId),
      );
    }

    const active = Object.values(this.store.read().drafts).filter(
      (draft) => draft.status === 'draft',
    ).length;
    if (active >= MAX_ACTIVE_DRAFTS) {
      throw errors.validation(
        'Too many open drafts. Publish or discard some first.',
      );
    }

    const id = `draft_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    const stored: StoredDraft = {
      id,
      connectionId,
      collection: collectionName,
      recordId,
      // Encrypted with the draft id as context, so the blob only decrypts
      // for this draft.
      values: this.vault.encryptJson(values, id),
      baseHash,
      version: 1,
      status: 'draft',
      createdBy: principal.id,
      updatedBy: principal.id,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.update((state) => {
      state.drafts[id] = stored;
    });

    this.audit.record({
      actor: principal.id,
      operation: 'draft.create',
      target: `${connectionId}/${collectionName}/${id}`,
      requestId,
      detail: { recordId },
    });
    this.announce('draft.created', stored);
    return this.view(principal, collection, stored);
  }

  /**
   * Change fields of a draft. `version` must match what the editor last saw.
   */
  async save(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    draftId: string,
    body: unknown,
    requestId: string,
  ): Promise<DraftView> {
    const collection = await this.collectionOf(connectionId, collectionName);
    if (!isPlainObject(body)) {
      throw errors.validation('Body must be an object');
    }
    const unknown = Object.keys(body).filter(
      (key) => key !== 'values' && key !== 'version',
    );
    if (unknown.length > 0) {
      throw errors.validation(`Unknown field: ${unknown[0]?.slice(0, 40)}`);
    }
    if (!Number.isInteger(body['version'])) {
      throw errors.validation('version is required');
    }

    const current = this.find(connectionId, collectionName, draftId);
    const access = accessFor(
      principal,
      collection,
      current.recordId ? 'update' : 'create',
    );
    checkValues(
      collection,
      body['values'],
      access,
      current.recordId ? 'update' : 'create',
    );

    const saved = await this.store.update((state) => {
      const draft = state.drafts[draftId];
      if (!draft || draft.status !== 'draft') {
        throw errors.conflict('This draft is no longer open');
      }
      // Optimistic locking: refuse a save made against an out-of-date version
      // rather than silently overwriting another editor. Checked inside the
      // store update so the compare and the write are atomic.
      if (draft.version !== body['version']) {
        throw errors.conflict(
          'Someone else changed this draft. Reload it to see their changes.',
          { currentVersion: draft.version },
        );
      }
      const merged = {
        ...this.vault.decryptJson<Record<string, unknown>>(
          draft.values,
          draft.id,
        ),
        ...(body['values'] as Record<string, unknown>),
      };
      draft.values = this.vault.encryptJson(merged, draft.id);
      draft.version += 1;
      draft.updatedBy = principal.id;
      draft.updatedAt = new Date().toISOString();
      return structuredClone(draft);
    });

    this.audit.record({
      actor: principal.id,
      operation: 'draft.update',
      target: `${connectionId}/${collectionName}/${draftId}`,
      requestId,
      detail: {
        fields: Object.keys(body['values'] as object),
        version: saved.version,
      },
    });
    this.announce('draft.updated', saved);
    return this.view(principal, collection, saved);
  }

  /** Close a draft without publishing. Conflict if already closed. */
  async discard(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    draftId: string,
    requestId: string,
  ): Promise<void> {
    const collection = await this.collectionOf(connectionId, collectionName);
    assertCanEdit(principal, collection);
    this.find(connectionId, collectionName, draftId);

    const discarded = await this.store.update((state) => {
      const draft = state.drafts[draftId];
      if (!draft || draft.status !== 'draft') {
        throw errors.conflict('This draft is no longer open');
      }
      draft.status = 'discarded';
      draft.updatedAt = new Date().toISOString();
      draft.updatedBy = principal.id;
      return structuredClone(draft);
    });
    this.audit.record({
      actor: principal.id,
      operation: 'draft.discard',
      target: `${connectionId}/${collectionName}/${draftId}`,
      requestId,
    });
    this.announce('draft.discarded', discarded);
  }

  /** Write the draft to the database. */
  async publish(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    draftId: string,
    body: unknown,
    requestId: string,
  ) {
    const collection = await this.collectionOf(connectionId, collectionName);
    const force = isPlainObject(body) && body['force'] === true;
    const expected = isPlainObject(body) ? body['version'] : undefined;
    const current = this.find(connectionId, collectionName, draftId);
    const access = accessFor(
      principal,
      collection,
      current.recordId ? 'update' : 'create',
    );

    // Claim the draft so a double click cannot publish twice.
    const claimed = await this.store.update((state) => {
      const draft = state.drafts[draftId];
      if (!draft || draft.status !== 'draft') {
        throw errors.conflict('This draft is no longer open');
      }
      if (expected !== undefined && draft.version !== expected) {
        throw errors.conflict(
          'The draft changed after you opened it. Review the latest version first.',
          { currentVersion: draft.version },
        );
      }
      // Intermediate state: other publish attempts now fail the status check.
      draft.status = 'publishing';
      return structuredClone(draft);
    });

    try {
      const values = this.vault.decryptJson<Record<string, unknown>>(
        claimed.values,
        claimed.id,
      );
      assertWritable(values, access);

      let published: Record<string, unknown>;
      if (claimed.recordId) {
        // `force` lets an editor knowingly overwrite later record changes.
        if (!force && claimed.baseHash) {
          await this.assertNotChangedMeanwhile(
            connectionId,
            collectionName,
            claimed,
          );
        }
        published = await this.records.update(
          principal,
          connectionId,
          collectionName,
          claimed.recordId,
          values,
          requestId,
          // Goes through RecordsService, so permissions and audit still apply.
          'record.publish',
        );
      } else {
        published = await this.records.create(
          principal,
          connectionId,
          collectionName,
          values,
          requestId,
          'record.publish',
        );
      }

      const recordId = String(
        published[primaryKeyOf(collection).name] ?? claimed.recordId,
      );
      const done = await this.store.update((state) => {
        const draft = state.drafts[draftId];
        if (!draft) {
          throw errors.notFound('Draft not found');
        }
        draft.status = 'published';
        draft.publishedAt = new Date().toISOString();
        draft.publishedRecordId = recordId;
        draft.updatedBy = principal.id;
        pruneFinished(state.drafts);
        return structuredClone(draft);
      });
      this.audit.record({
        actor: principal.id,
        operation: 'draft.publish',
        target: `${connectionId}/${collectionName}/${draftId}`,
        requestId,
        detail: { recordId },
      });
      this.announce('draft.published', done);
      return {
        draft: this.view(principal, collection, done),
        record: published,
      };
    } catch (error) {
      // Put the draft back so the editor can fix the problem and try again.
      await this.store.update((state) => {
        const draft = state.drafts[draftId];
        if (draft && draft.status === 'publishing') {
          draft.status = 'draft';
        }
      });
      throw error;
    }
  }

  // ---- Preview --------------------------------------------------------

  /** Create a short-lived link that shows this draft without an API token. */
  async createPreviewLink(
    principal: Principal,
    connectionId: string,
    collectionName: string,
    draftId: string,
    requestId: string,
  ) {
    const collection = await this.collectionOf(connectionId, collectionName);
    assertCanEdit(principal, collection);
    this.find(connectionId, collectionName, draftId);
    // The link records its creator, so the viewer sees only what that person
    // may read, not what the link's holder could.
    const { token, expiresAt } = this.previews.sign(
      { draftId, principalId: principal.id },
      PREVIEW_TTL_SECONDS,
    );
    this.audit.record({
      actor: principal.id,
      operation: 'preview.create',
      target: `${connectionId}/${collectionName}/${draftId}`,
      requestId,
    });
    return {
      token,
      path: `/v1/preview/${token}`,
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  }

  /**
   * What a preview link shows: the published record with the draft's changes on
   * top.
   */
  // The link is only a bearer proof: the creator must still exist, so
  // revoking their token also kills their links.
  async previewFor(token: string) {
    const claims = this.previews.verify(token);
    const caller = claims ? this.auth.find(claims.principalId) : null;
    if (!claims || !caller) {
      // One message for bad signature, expiry and unknown user: no hints.
      throw errors.authFailed('This preview link is invalid or has expired');
    }

    const draft = this.store.read().drafts[claims.draftId];
    if (!draft) {
      throw errors.notFound('Draft not found');
    }
    const collection = await this.collectionOf(
      draft.connectionId,
      draft.collection,
    );
    return {
      claims,
      caller,
      draft,
      collection,
      ...(await this.merged(caller, collection, draft)),
    };
  }

  /**
   * Published values with the draft's changes applied, shaped for the viewer.
   */
  async merged(
    viewer: Principal,
    collection: CollectionDefinition,
    draft: StoredDraft,
  ) {
    // Masking uses the viewer's own read access.
    const read = tryReadAccess(viewer, collection);
    if (!read) {
      throw errors.forbidden('Your role cannot read this collection');
    }

    let base: Record<string, unknown> = {};
    if (draft.recordId) {
      try {
        base = await this.records.rawGet(
          draft.connectionId,
          draft.collection,
          draft.recordId,
        );
      } catch {
        base = {}; // the record was deleted; the preview shows only the draft
      }
    }
    const values = this.vault.decryptJson<Record<string, unknown>>(
      draft.values,
      draft.id,
    );
    return {
      data: maskRecord({ ...base, ...values }, read),
      meta: {
        draftId: draft.id,
        version: draft.version,
        status: draft.status,
        recordId: draft.recordId,
        updatedAt: draft.updatedAt,
      },
    };
  }

  // ---- Internals ------------------------------------------------------

  /** Resolve the collection definition, or throw not found. */
  private async collectionOf(
    connectionId: string,
    name: string,
  ): Promise<CollectionDefinition> {
    return (await this.registry.bind(connectionId)).model.require(name);
  }

  private find(
    connectionId: string,
    collectionName: string,
    draftId: string,
  ): StoredDraft {
    const draft = this.store.read().drafts[draftId];
    // Same answer for "no such draft" and "draft belongs elsewhere", so ids
    // cannot be probed.
    if (
      !draft ||
      draft.connectionId !== connectionId ||
      draft.collection !== collectionName
    ) {
      throw errors.notFound('Draft not found');
    }
    return draft;
  }

  /**
   * Compare the record's current fingerprint with the one saved at draft
   * start.
   *
   * @throws Conflict if the record changed or was deleted since.
   */
  private async assertNotChangedMeanwhile(
    connectionId: string,
    collectionName: string,
    draft: StoredDraft,
  ): Promise<void> {
    let currentHash: string | null;
    try {
      currentHash = fingerprint(
        await this.records.rawGet(
          connectionId,
          collectionName,
          draft.recordId as string,
        ),
      );
    } catch {
      throw errors.conflict(
        'The record was deleted after this draft was started.',
      );
    }
    if (currentHash !== draft.baseHash) {
      throw errors.conflict(
        'The published record changed after this draft was started. Review it, or publish again with force.',
        {
          reason: 'record_changed',
        },
      );
    }
  }

  /** Decrypt a stored draft and mask it for this caller. */
  private view(
    principal: Principal,
    collection: CollectionDefinition,
    draft: StoredDraft,
  ): DraftView {
    const values = this.vault.decryptJson<Record<string, unknown>>(
      draft.values,
      draft.id,
    );
    const read = tryReadAccess(principal, collection);
    return {
      id: draft.id,
      connectionId: draft.connectionId,
      collection: draft.collection,
      recordId: draft.recordId,
      values: read ? maskRecord(values, read) : {},
      version: draft.version,
      status: draft.status,
      createdBy: draft.createdBy,
      updatedBy: draft.updatedBy,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      ...(draft.publishedAt ? { publishedAt: draft.publishedAt } : {}),
      ...(draft.publishedRecordId
        ? { publishedRecordId: draft.publishedRecordId }
        : {}),
    };
  }

  /** Publish a draft event on the bus (feeds live streams and webhooks). */
  private announce(
    type:
      'draft.created' | 'draft.updated' | 'draft.discarded' | 'draft.published',
    draft: StoredDraft,
  ): void {
    this.events.publish({
      type,
      connectionId: draft.connectionId,
      collection: draft.collection,
      draftId: draft.id,
      recordId: draft.recordId,
      version: draft.version,
    });
  }

}

// Re-exported so callers can import both from the drafts module.
export { visibleRecord };
