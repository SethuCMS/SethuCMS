/**
 * Copying data from one connection to another.
 *
 * - `plan()` checks everything and writes nothing (a dry run).
 * - `start()` runs the copy in the background and returns a job to poll.
 *
 * Safety rules:
 *   - Administrators only (the routes check this); the target must be read-
 *     write.
 *   - The source is only ever read.
 *   - Records are written one at a time through the adapter, validated against
 *     the target's own field rules first.
 *   - Only one migration runs at a time per gateway.
 *   - Record values are never logged, audited or put in error messages. Errors
 *     carry the collection, the source id, a code and a short reason.
 *
 * Re-running is safe when ids are kept (conflicts are skipped by default), so a
 * stopped or failed migration is resumed by running it again. When the target
 * assigns its own ids, the target collection must start empty.
 *
 * With `createMissing`, collections the target lacks are created first (same
 * fields and key, ids kept), in the order that lets foreign keys point at
 * tables
 * that already exist. Existing target collections are never altered.
 * Changes made to the source while it runs may be missed.
 */
import { randomUUID } from 'node:crypto';
import type { Adapter } from '@sethucms/adapter-sdk';
import {
  canonicalJson,
  errors,
  isSethuError,
  primaryKeyOf,
  isValueOfType,
  validateRecord,
  type CollectionDefinition,
} from '@sethucms/core';
import type { AuditLog } from '../audit.js';
import type { ConnectionRegistry } from '../connections/registry.js';
import type { EventBus } from '../events.js';
import type { Logger } from '../logger.js';
import type { Counter } from '../metrics.js';
import type { StateStore, StoredConnection } from '../store/state.js';
import {
  LIMITS,
  deriveTarget,
  orderByReferences,
  parseMigrationRequest,
  planCollection,
  type CollectionPlan,
  type CollectionSpec,
  type MigrationPlan,
  type MigrationRequest,
} from './plan.js';

// Everything a run needs, produced once by `prepare` so a dry run and a real
// run work from the same checked plan.
interface Prepared {
  plan: MigrationPlan;
  source: {
    connection: StoredConnection;
    adapter: Adapter;
    discovered: CollectionDefinition[];
  };
  target: {
    connection: StoredConnection;
    adapter: Adapter;
    discovered: CollectionDefinition[];
  };
  sourceDefs: Map<string, CollectionDefinition>;
  targetDefs: Map<string, CollectionDefinition>;
  specs: Map<string, CollectionSpec>;
  /** Source collection names whose target collection will be created. */
  toCreate: Set<string>;
}

/** Final or current state of a migration job. */
export type JobStatus =
  'running' | 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

/** Live counters for one collection of a job. */
export interface CollectionProgress {
  from: string;
  to: string;
  state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  total: number | null;
  read: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /**
   * Stored records whose values differ from what was sent (checked after each
   * write).
   */
  differences: number;
  /**
   * After the copy: how many records the target gained, against how many were
   * created.
   */
  verified: boolean | null;
  note?: string;
}

/**
 * One failed record. Holds ids and short reasons only, never record
 * values, so job history cannot leak content.
 */
export interface JobError {
  collection: string;
  /** The record's id in the source. */
  id: string;
  code: string;
  message: string;
}

/** A migration run as shown to admins; also what is saved as history. */
export interface MigrationJob {
  id: string;
  status: JobStatus;
  actor: string;
  source: string;
  target: string;
  onConflict: string;
  startedAt: string;
  finishedAt?: string;
  collections: CollectionProgress[];
  errors: JobError[];
  /** True when more errors happened than are listed. */
  errorsTruncated: boolean;
  message?: string;
  /**
   * Refreshed while the job runs. With shared state it tells other gateways the
   * job is alive.
   */
  heartbeatAt?: string;
}

// In-process handle for a running job. `cancel` is checked between records.
interface Run {
  job: MigrationJob;
  cancel: boolean;
  done: Promise<void>;
}

// Per-call limits: a database call is abandoned after 30s; only transient
// connection failures are retried.
const CALL_TIMEOUT_MS = 30_000;
const MAX_KEPT_JOBS = 50;
const MAX_LISTED_ERRORS = 100;
const RETRY_CODES = new Set(['TIMEOUT', 'CONNECTION_FAILED']);

/** Dependencies of `MigrationManager`. */
export interface MigrationDeps {
  registry: ConnectionRegistry;
  /** Where job history is kept, so it survives a restart. */
  store: StateStore;
  audit: AuditLog;
  events: EventBus;
  logger: Logger;
  records: Counter;
  /**
   * Several gateways share the saved state: a running job may belong to another
   * gateway.
   */
  shared?: boolean;
}

// A running job refreshes a heartbeat every 15s; with shared state, other
// gateways treat a job silent for 60s as dead.
const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;

/**
 * Plans and runs data copies between two connections.
 *
 * Admin-only (the routes enforce it). One job runs at a time per
 * gateway, and with shared state only one across all gateways. The
 * source is only read; record values are never logged or audited.
 */
export class MigrationManager {
  private readonly jobs = new Map<string, Run>();
  private active: Run | undefined;
  /** History writes in flight, so shutdown can wait for them. */
  private readonly saving = new Set<Promise<unknown>>();
  private heartbeat: NodeJS.Timeout | undefined;
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly deps: MigrationDeps) {}

  // ---- Plan -----------------------------------------------------------

  /**
   * Dry run: validate the request and report what would happen.
   *
   * @param input Untrusted request body.
   * @returns A plan with problems and warnings; nothing is written.
   * @throws A validation error for a malformed request.
   */
  async plan(input: unknown): Promise<MigrationPlan> {
    return (await this.prepare(parseMigrationRequest(input), true)).plan;
  }

  // ---- Run ------------------------------------------------------------

  /**
   * Start a migration in the background.
   *
   * @param input Untrusted request body.
   * @param actor Id of the admin starting it (recorded in the audit log).
   * @returns The new job (a snapshot); poll `get` for progress.
   * @throws Conflict if another migration is running, read-only error if
   *   the target is read-only, validation error if the plan has problems.
   */
  async start(input: unknown, actor: string): Promise<MigrationJob> {
    if (this.active) {
      throw errors.conflict(
        'A migration is already running. Wait for it to finish or cancel it',
      );
    }
    if (this.runningElsewhere()) {
      throw errors.conflict(
        'A migration is already running on another gateway. Wait for it to finish',
      );
    }
    const request = parseMigrationRequest(input);
    // Re-plan now with fresh data instead of trusting an earlier dry run.
    const prepared = await this.prepare(request, false);
    const { plan } = prepared;

    if (prepared.target.connection.mode !== 'read_write') {
      throw errors.readOnly(
        'The target connection is read-only. Switch it to read-write before migrating',
      );
    }
    if (!plan.ready) {
      throw errors.validation('The migration cannot start yet', [
        ...plan.problems.map((message) => ({ path: '', message })),
        ...plan.collections.flatMap((collection) =>
          collection.problems.map((message) => ({
            path: collection.from,
            message,
          })),
        ),
      ]);
    }
    // Targets that renumber records must start empty, or a re-run would
    // duplicate everything.
    for (const collection of plan.collections) {
      if (
        !collection.idsPreserved &&
        (collection.targetRecords?.count ?? 0) > 0
      ) {
        throw errors.conflict(
          `"${collection.to}" in the target already has records and assigns its own ids, so copying again would create duplicates. Empty it first`,
        );
      }
    }
    // Checked again after the awaits above, since another start may have
    // slipped in while we were planning.
    if (this.active || this.runningElsewhere()) {
      throw errors.conflict('A migration is already running');
    }

    const job: MigrationJob = {
      id: `mig_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      status: 'running',
      actor,
      source: prepared.source.connection.id,
      target: prepared.target.connection.id,
      onConflict: request.onConflict,
      startedAt: new Date().toISOString(),
      collections: plan.collections.map((collection) => ({
        from: collection.from,
        to: collection.to,
        state: 'waiting' as const,
        total: collection.sourceRecords?.exact
          ? collection.sourceRecords.count
          : null,
        read: 0,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        differences: 0,
        verified: null,
      })),
      errors: [],
      errorsTruncated: false,
      heartbeatAt: new Date().toISOString(),
    };
    const run: Run = { job, cancel: false, done: Promise.resolve() };
    this.active = run;
    this.remember(run);
    this.save(job);
    this.heartbeat = setInterval(() => {
      job.heartbeatAt = new Date().toISOString();
      this.save(job);
    }, HEARTBEAT_MS);
    this.heartbeat.unref();

    this.deps.audit.record({
      actor,
      operation: 'migration.start',
      target: `${job.source}->${job.target}`,
      detail: {
        job: job.id,
        collections: plan.collections.map((c) => `${c.from}->${c.to}`),
        onConflict: request.onConflict,
        dropUnmappedFields: request.dropUnmappedFields,
      },
    });
    this.deps.logger.info({
      event: 'migration.start',
      job: job.id,
      source: job.source,
      target: job.target,
      collections: job.collections.length,
    });

    // Fire and forget: errors are caught here so the job ends as "failed"
    // and the message shown to users is generic (details go to the log).
    run.done = this.execute(run, request, prepared, actor).catch(
      (error: unknown) => {
        this.deps.logger.error({
          event: 'migration.crash',
          job: job.id,
          error: error instanceof Error ? error.message : 'unknown',
        });
        this.finish(
          run,
          'failed',
          'The migration stopped because of an unexpected error. See the server log',
        );
      },
    );
    return structuredClone(job);
  }

  /** Get a job snapshot, from memory or saved history. */
  get(id: string): MigrationJob {
    const run = this.jobs.get(id);
    if (run) {
      return structuredClone(run.job);
    }
    const stored = this.deps.store.read().migrations[id];
    if (!stored) {
      throw errors.notFound('Migration not found');
    }
    return structuredClone(stored);
  }

  /** Recent jobs, newest first. */
  list(): MigrationJob[] {
    const all = new Map<string, MigrationJob>(
      Object.entries(this.deps.store.read().migrations),
    );
    for (const [id, run] of this.jobs) {
      all.set(id, run.job);
    }
    return [...all.values()]
      .map((job) => structuredClone(job))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, MAX_KEPT_JOBS);
  }

  /**
   * Call once when the gateway starts. A job still marked "running" in the
   * saved
   * history belongs to a gateway that stopped; mark it so nobody waits for it.
   * Records already copied stay copied, and running it again continues (when
   * ids are kept).
   */
  async recover(): Promise<number> {
    const interrupted = this.abandoned(!this.deps.shared);
    if (interrupted.length === 0) {
      return 0;
    }
    await this.markInterrupted(interrupted.map((job) => job.id));
    for (const job of interrupted) {
      this.deps.audit.record({
        actor: 'system',
        operation: 'migration.interrupted',
        target: `${job.source}->${job.target}`,
        detail: { job: job.id },
      });
    }
    this.deps.logger.warn({
      event: 'migration.interrupted',
      count: interrupted.length,
    });
    return interrupted.length;
  }

  /**
   * With shared state, keep looking for jobs whose gateway died (no heartbeat
   * for a minute).
   */
  watchForAbandoned(): void {
    if (!this.deps.shared || this.sweeper) {
      return;
    }
    this.sweeper = setInterval(
      () => void this.recover().catch(() => undefined),
      STALE_MS / 2,
    );
    this.sweeper.unref();
  }

  /**
   * Jobs saved as running. Alone, all of them are leftovers of a stopped
   * gateway; shared, only those without a recent heartbeat.
   */
  private abandoned(all: boolean): MigrationJob[] {
    const now = Date.now();
    return Object.values(this.deps.store.read().migrations).filter((job) => {
      if (
        job.status !== 'running' ||
        this.jobs.get(job.id)?.job.status === 'running'
      ) {
        return false;
      }
      return (
        all || !job.heartbeatAt || now - Date.parse(job.heartbeatAt) > STALE_MS
      );
    });
  }

  /** A job another gateway is running right now. */
  private runningElsewhere(): boolean {
    if (!this.deps.shared) {
      return false;
    }
    const now = Date.now();
    return Object.values(this.deps.store.read().migrations).some(
      (job) =>
        job.status === 'running' &&
        !this.jobs.has(job.id) &&
        job.heartbeatAt !== undefined &&
        now - Date.parse(job.heartbeatAt) <= STALE_MS,
    );
  }

  // Marked "failed" (not "cancelled") because nobody asked for the stop.
  private async markInterrupted(ids: string[]): Promise<void> {
    const wanted = new Set(ids);
    await this.deps.store.update((state) => {
      for (const job of Object.values(state.migrations)) {
        if (!wanted.has(job.id) || job.status !== 'running') {
          continue;
        }
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.message =
          'The gateway stopped while this migration was running. Records already copied are kept. Run it again to continue';
        for (const collection of job.collections) {
          if (
            collection.state === 'running' ||
            collection.state === 'waiting'
          ) {
            collection.state = 'skipped';
          }
        }
      }
    });
  }

  /**
   * Save a snapshot of the job. Failures are logged, never thrown: history must
   * not stop a copy.
   */
  private save(job: MigrationJob): void {
    const snapshot = structuredClone(job);
    const pending: Promise<unknown> = this.deps.store
      .update((state) => {
        state.migrations[snapshot.id] = snapshot;
        const ids = Object.values(state.migrations)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .map((item) => item.id);
        for (const id of ids.slice(MAX_KEPT_JOBS)) {
          delete state.migrations[id];
        }
      })
      .catch((error: unknown) =>
        this.deps.logger.warn({
          event: 'migration.save_failed',
          job: snapshot.id,
          error: error instanceof Error ? error.message : 'unknown',
        }),
      )
      .finally(() => this.saving.delete(pending));
    this.saving.add(pending);
  }

  /**
   * Ask the running migration to stop after the record it is on. Records
   * already copied stay copied.
   */
  cancel(id: string, actor: string): MigrationJob {
    const run = this.jobs.get(id);
    if (!run) {
      throw errors.notFound('Migration not found');
    }
    if (run.job.status !== 'running') {
      throw errors.conflict('This migration has already finished');
    }
    run.cancel = true;
    this.deps.audit.record({
      actor,
      operation: 'migration.cancel',
      target: id,
    });
    return structuredClone(run.job);
  }

  /** Stop and wait, used when the gateway shuts down. */
  async stop(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    if (this.sweeper) {
      clearInterval(this.sweeper);
    }
    const run = this.active;
    if (run) {
      run.cancel = true;
      await run.done;
    }
    await Promise.allSettled([...this.saving]);
  }

  // ---- Planning internals ---------------------------------------------

  // Shared by plan and start. Reads both schemas, orders collections so
  // referenced ones come first, plans each one, and optionally counts rows.
  private async prepare(request: MigrationRequest, withCounts: boolean) {
    const source = await this.deps.registry.raw(request.source);
    const target = await this.deps.registry.raw(request.target);

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

  // Order of work: create missing collections, re-plan against what the
  // database really made, copy each collection, verify, then finish.
  private async execute(
    run: Run,
    request: MigrationRequest,
    prepared: Prepared,
    actor: string,
  ): Promise<void> {
    const { plan, sourceDefs, specs, toCreate } = prepared;
    const from = prepared.source.adapter;
    const to = prepared.target.adapter;
    let targetDefs = prepared.targetDefs;
    const { job } = run;
    /**
     * For collections whose ids change: old id -> new id, used to rewrite
     * references.
     */
    const idMaps = new Map<string, Map<string, unknown>>();
    let stoppedForErrors = false;
    const createFailed = new Set<string>();

    // Create what is missing, in reference order, then read the real structure
    // back.
    if (toCreate.size > 0) {
      for (let index = 0; index < plan.collections.length; index += 1) {
        const entry = plan.collections[index]!;
        const progress = job.collections[index]!;
        if (!toCreate.has(entry.from) || run.cancel) {
          continue;
        }
        try {
          await to.createCollection!(targetDefs.get(entry.to)!);
          progress.note = 'Created in the target';
          this.deps.audit.record({
            actor,
            operation: 'migration.create_collection',
            target: `${job.target}/${entry.to}`,
            detail: { job: job.id },
          });
        } catch (error) {
          createFailed.add(entry.from);
          progress.state = 'failed';
          progress.note = `Could not create it: ${describe(error)}`;
        }
      }
      targetDefs = new Map(
        (await this.deps.registry.rediscover(job.target)).map((collection) => [
          collection.name,
          collection,
        ]),
      );
      // Plan again against the tables as the database really made them.
      for (let index = 0; index < plan.collections.length; index += 1) {
        const old = plan.collections[index]!;
        if (!toCreate.has(old.from) || createFailed.has(old.from)) {
          continue;
        }
        const real = targetDefs.get(old.to);
        const spec = specs.get(old.from);
        const replanned =
          real && spec
            ? planCollection(
                spec,
                sourceDefs.get(old.from),
                real,
                request.dropUnmappedFields,
                true,
                sourceDefs,
                true,
                typeof to.finishBulkLoad === 'function',
              )
            : undefined;
        if (!replanned || replanned.problems.length > 0) {
          createFailed.add(old.from);
          job.collections[index]!.state = 'failed';
          job.collections[index]!.note =
            `The new collection does not match the source: ${replanned?.problems[0] ?? 'it was not found after creating it'}`;
          continue;
        }
        plan.collections[index] = replanned;
      }
    }

    for (let index = 0; index < plan.collections.length; index += 1) {
      const entry = plan.collections[index]!;
      const progress = job.collections[index]!;
      const sourceDef = sourceDefs.get(entry.from)!;
      const targetDef = targetDefs.get(entry.to)!;
      if (createFailed.has(entry.from)) {
        continue;
      }
      // Cancel and the error budget stop work at the next collection boundary.
      if (run.cancel || stoppedForErrors) {
        progress.state = 'skipped';
        continue;
      }

      progress.state = 'running';
      const idMap = new Map<string, unknown>();
      if (!entry.idsPreserved) {
        idMaps.set(entry.from, idMap);
      }

      try {
        const before = request.verify
          ? await count(to, targetDef, LIMITS.hardMaxRecords)
          : null;
        await this.copyCollection(
          run,
          request,
          from,
          to,
          entry,
          progress,
          sourceDef,
          targetDef,
          idMaps,
          idMap,
        );
        if (request.verify && before) {
          // Verified by comparing row counts before and after; `null` means
          // unknown (counts were capped), not failed.
          const after = await count(to, targetDef, LIMITS.hardMaxRecords);
          progress.verified =
            before.exact && after.exact
              ? after.count - before.count === progress.created
              : null;
        }
        progress.state = progress.failed > 0 ? 'failed' : 'done';
        await this.finishIds(to, targetDef, entry, request, progress);
      } catch (error) {
        progress.state = 'failed';
        progress.note = describe(error);
      }
      this.save(job);
      this.deps.logger.info({
        event: 'migration.collection',
        job: job.id,
        collection: entry.from,
        state: progress.state,
        created: progress.created,
        updated: progress.updated,
        skipped: progress.skipped,
        failed: progress.failed,
      });
      if (
        job.errors.length + (job.errorsTruncated ? 1 : 0) >=
        request.maxErrors
      ) {
        stoppedForErrors = true;
      }
    }

    const failed = job.collections.some(
      (collection) => collection.state === 'failed',
    );
    if (run.cancel) {
      this.finish(
        run,
        'cancelled',
        'Stopped on request. Run it again to continue',
      );
    } else if (stoppedForErrors) {
      this.finish(
        run,
        'failed',
        `Stopped after ${request.maxErrors} errors. Fix them and run it again to continue`,
      );
    } else {
      this.finish(run, failed ? 'completed_with_errors' : 'completed');
    }
  }

  /**
   * After original ids were written into a database-numbered key, move its
   * counter past the highest id.
   */
  private async finishIds(
    to: Adapter,
    targetDef: CollectionDefinition,
    entry: CollectionPlan,
    request: MigrationRequest,
    progress: CollectionProgress,
  ): Promise<void> {
    const key = primaryKeyOf(targetDef);
    if (
      !(request.preserveIds || entry.create) ||
      !key.generated ||
      typeof to.finishBulkLoad !== 'function'
    ) {
      return;
    }
    try {
      await withRetry(() => to.finishBulkLoad!(targetDef));
    } catch (error) {
      progress.note = `Records were copied, but the id counter could not be moved: ${describe(error)}. New records may collide with copied ids until it is`;
    }
  }

  // Pages through the source with a cursor. Cancel is checked per record.
  private async copyCollection(
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
          const outcome = await this.copyOne(
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
          this.deps.records.inc({ result: outcome.result });
          if (outcome.different) {
            progress.differences += 1;
          }
        } catch (error) {
          progress.failed += 1;
          this.deps.records.inc({ result: 'failed' });
          this.addError(
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
  private async copyOne(
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

  // Keep only the first few errors in the job; the rest are just counted.
  private addError(
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

  // Idempotent: the first terminal status wins.
  private finish(run: Run, status: JobStatus, message?: string): void {
    const { job } = run;
    if (job.status !== 'running') {
      return;
    }
    job.status = status;
    job.finishedAt = new Date().toISOString();
    if (message) {
      job.message = message;
    }
    for (const collection of job.collections) {
      if (collection.state === 'running' || collection.state === 'waiting') {
        collection.state = 'skipped';
      }
    }
    if (this.active === run) {
      this.active = undefined;
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
      }
    }
    this.save(job);

    const totals = job.collections.reduce(
      (sum, c) => ({
        created: sum.created + c.created,
        updated: sum.updated + c.updated,
        skipped: sum.skipped + c.skipped,
        failed: sum.failed + c.failed,
      }),
      { created: 0, updated: 0, skipped: 0, failed: 0 },
    );
    this.deps.audit.record({
      actor: job.actor,
      operation: 'migration.finish',
      target: `${job.source}->${job.target}`,
      detail: { job: job.id, status, ...totals },
    });
    this.deps.logger[status === 'completed' ? 'info' : 'warn']({
      event: 'migration.finish',
      job: job.id,
      status,
      ...totals,
    });
    this.deps.events.publish({
      type: 'connection.changed',
      connectionId: job.target,
    });
  }

  // Keep a bounded in-memory history; running jobs are never evicted.
  private remember(run: Run): void {
    this.jobs.set(run.job.id, run);
    if (this.jobs.size <= MAX_KEPT_JOBS) {
      return;
    }
    for (const [id, old] of this.jobs) {
      if (old.job.status !== 'running') {
        this.jobs.delete(id);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------

/** Count records by reading pages of keys, up to `cap`. */
async function count(
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
async function withRetry<T>(call: () => Promise<T>): Promise<T> {
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
function withTimeout<T>(promise: Promise<T>): Promise<T> {
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
function differs(
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

function sameValue(
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
function codeAndMessage(error: unknown): { code: string; message: string } {
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
function describe(error: unknown): string {
  return codeAndMessage(error).message;
}
