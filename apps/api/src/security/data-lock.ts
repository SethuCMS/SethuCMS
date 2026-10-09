/**
 * One gateway per data folder.
 *
 * The gateway keeps its state (connections, drafts, tokens, audit chain) in
 * files and in memory, so two gateways writing to the same folder would
 * overwrite each other's changes and break the audit chain. This lock turns
 * that
 * silent corruption into a clear refusal to start.
 *
 * The lock is a small file whose modification time is refreshed every few
 * seconds while the gateway runs. A lock that has not been refreshed for a
 * while belongs to a gateway that is gone (crashed or killed), and is taken
 * over.
 */
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

/** Handle for a held data-folder lock. */
export interface DataLock {
  /** Stop refreshing and delete the lock file. Call on shutdown. */
  release(): Promise<void>;
}

/** Tuning for {@link acquireDataLock}. */
export interface LockOptions {
  /**
   * A lock not refreshed for this long is considered abandoned. Default 30 s.
   */
  staleMs?: number;
  /** How often the running gateway refreshes its lock. Default 10 s. */
  heartbeatMs?: number;
  /** Start even if a live lock exists. For recovery only. */
  force?: boolean;
}

/**
 * Take the single-gateway lock for a data folder.
 *
 * @param dataDir Folder holding the gateway state.
 * @param options Staleness, heartbeat and force settings.
 * @returns A handle whose `release()` must be called on shutdown.
 * @throws Error when a live gateway already holds the lock.
 */
export async function acquireDataLock(
  dataDir: string,
  options: LockOptions = {},
): Promise<DataLock> {
  const staleMs = options.staleMs ?? 30_000;
  const heartbeatMs = options.heartbeatMs ?? 10_000;
  const path = join(dataDir, 'gateway.lock');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const contents = JSON.stringify({
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Flag "wx" creates the file only if absent, so two starters cannot
      // both win (atomic test-and-set).
      await writeFile(path, contents, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      // Lock age is judged by file mtime, which the owner keeps refreshing.
      const age =
        Date.now() -
        (await stat(path).then(
          (info) => info.mtimeMs,
          () => 0,
        ));
      if (age < staleMs && !options.force) {
        const owner: { pid?: number; host?: string } = await readFile(
          path,
          'utf8',
        ).then(
          (text) => JSON.parse(text) as { pid?: number; host?: string },
          () => ({}),
        );
        throw new Error(
          `Another gateway appears to be using the data folder (process ${owner.pid ?? 'unknown'} on ${owner.host ?? 'unknown'}, ` +
            `lock refreshed ${Math.round(age / 1000)} s ago). Run one gateway per data folder. ` +
            `If none is running, wait ${Math.ceil((staleMs - age) / 1000)} s and start again.`,
        );
      }
      await rm(path, { force: true }); // abandoned: take it over
      if (attempt === 1) {
        throw error;
      }
    }
  }

  // Heartbeat: refresh mtime so other starters see the lock as live.
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(path, now, now).catch(() => undefined);
  }, heartbeatMs);
  // Do not let the heartbeat alone keep the process running.
  timer.unref();

  return {
    async release() {
      clearInterval(timer);
      await rm(path, { force: true });
    },
  };
}
