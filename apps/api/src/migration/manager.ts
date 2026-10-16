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
  errors,
  primaryKeyOf,
  type CollectionDefinition,
} from '@sethucms/core';
import {
  LIMITS,
  parseMigrationRequest,
  planCollection,
  type CollectionPlan,
  type MigrationPlan,
  type MigrationRequest,
} from './plan.js';
import { copyCollection } from './copy.js';
import { prepareMigration } from './prepare.js';
import {
  MAX_KEPT_JOBS,
  type CollectionProgress,
  type JobStatus,
  type MigrationDeps,
  type MigrationJob,
  type Prepared,
  type Run,
} from './manager-types.js';
import { count, describe, withRetry } from './manager-helpers.js';

export type {
  CollectionProgress,
  JobError,
  JobStatus,
  MigrationDeps,
  MigrationJob,
} from './manager-types.js';

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

  // The checked plan and open adapters for a request (see prepare.ts).
  private prepare(request: MigrationRequest, withCounts: boolean) {
    return prepareMigration(this.deps, request, withCounts);
  }

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
        await copyCollection(
        this.deps.records,
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
