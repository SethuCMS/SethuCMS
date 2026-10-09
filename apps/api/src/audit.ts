/**
 * The audit log: who did what, and when.
 *
 * Entries are only ever appended. Details pass through `redact` first, so
 * passwords, tokens and connection-string credentials never reach the log.
 *
 * Tamper evidence: each entry carries the hash of the entry before it
 * (`prev`) and its own hash (`hash`, SHA-256 over `prev` and the entry).
 * Changing, removing or reordering a line breaks the chain, and `verify()`
 * reports where. This shows tampering; it does not prevent it, so keep a copy
 * of the log somewhere the gateway cannot write.
 *
 * Rotation: when the file passes a size limit it becomes audit.log.1, the
 * older ones shift up, and the oldest beyond the keep count is deleted. The
 * chain continues across files.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { canonicalJson, redact } from '@sethucms/core';

/** One line of the audit log. */
export interface AuditEntry {
  /** Unique id of the entry. */
  id: string;
  /** ISO timestamp of when it was recorded. */
  at: string;
  /** Who did it (usually the token id). */
  actor: string;
  /** What was done, e.g. "record.update". */
  operation: string;
  /** What was affected, for example "orders/42" or "connection:conn_ab12". */
  target: string;
  /** Correlates the entry with the request log. */
  requestId?: string;
  /** Extra context, already redacted of secrets. */
  detail?: unknown;
  /** Hash of the previous entry (64 zeros for the very first one). */
  prev?: string;
  /** Hash of this entry. */
  hash?: string;
}

/** What callers supply; id, time and chain fields are added by the log. */
export type AuditInput = Omit<AuditEntry, 'id' | 'at' | 'prev' | 'hash'>;

/** Rotation settings for {@link AuditLog.open}. */
export interface AuditOptions {
  /** Rotate when the file would grow past this many bytes. Default 10 MB. */
  maxBytes?: number;
  /** How many rotated files to keep (audit.log.1 ... .N). Default 5. */
  keepFiles?: number;
}

/** Result of {@link AuditLog.verify}. */
export interface AuditVerification {
  /** False if any tampering or gap was detected. */
  ok: boolean;
  /** Entries whose hash and link were checked. */
  checked: number;
  /** Older entries written before hashing existed (skipped). */
  unchained: number;
  /**
   * True when the oldest entry still on disk is the very first one ever
   * written.
   */
  completeHistory: boolean;
  firstAt?: string;
  lastAt?: string;
  /** Where the chain first breaks. */
  brokenAt?: { file: string; line: number; id?: string; reason: string };
}

/** `prev` value of the first entry in a chain. */
const GENESIS = '0'.repeat(64);
/** How many recent entries stay in RAM for quick listing. */
const KEEP_IN_MEMORY = 1000;
/** Default rotation size (10 MB). */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Default number of rotated files kept. */
const DEFAULT_KEEP_FILES = 5;

/**
 * Hash an entry for the chain.
 * @param entry The entry; its own `hash` field is ignored.
 * @returns SHA-256 hex over the canonical JSON of the rest, which includes
 * `prev`, so each hash commits to all earlier entries.
 */
export const hashEntry = (entry: AuditEntry): string => {
  // Canonical JSON gives a stable key order, so the same entry always
  // hashes the same regardless of how it was parsed.
  const { hash: _ignored, ...rest } = entry;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
};

/**
 * Where entries go when several gateways share one database. Each gateway
 * process writes its own hash chain (so chains never interleave) into one
 * table.
 */
export interface AuditSink {
  /** Chain name of this process. */
  readonly chain: string;
  append(entry: AuditEntry): Promise<void>;
  /** Newest first, across all chains. */
  latest(limit: number): Promise<AuditEntry[]>;
  /** Every chain, oldest entry first, grouped by chain. */
  chains(): AsyncIterable<{ chain: string; entries: AuditEntry[] }>;
}

/**
 * Append-only, hash-chained audit log, backed by a file, a shared
 * database sink, or memory only.
 */
export class AuditLog {
  private sink: AuditSink | undefined;
  private recent: AuditEntry[] = [];
  private pending: Promise<unknown> = Promise.resolve();
  private lastHash = GENESIS;
  private size = 0;
  private total = 0;

  private constructor(
    private readonly path: string | undefined,
    private readonly maxBytes: number,
    private readonly keepFiles: number,
  ) {}

  /**
   * Open (or create) the file-backed log and resume its chain.
   * @param dataDir Folder for `audit.log`; omit for memory only.
   * @param options Rotation limits.
   */
  static async open(
    dataDir?: string,
    options: AuditOptions = {},
  ): Promise<AuditLog> {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const keepFiles = Math.max(1, options.keepFiles ?? DEFAULT_KEEP_FILES);
    if (!dataDir) {
      return new AuditLog(undefined, maxBytes, keepFiles);
    }
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const log = new AuditLog(join(dataDir, 'audit.log'), maxBytes, keepFiles);

    const lines = await readLines(log.path as string);
    log.recent = lines.slice(-KEEP_IN_MEMORY).flatMap(parseLine);
    log.size = lines.reduce(
      (sum, line) => sum + Buffer.byteLength(line) + 1,
      0,
    );
    // Continue the chain from the newest hashed entry, looking in rotated files
    // if this one is empty.
    for (const file of [
      log.path as string,
      ...Array.from({ length: keepFiles }, (_, i) => `${log.path}.${i + 1}`),
    ]) {
      const entries = (await readLines(file)).flatMap(parseLine);
      const lastHashed = [...entries].reverse().find((entry) => entry.hash);
      if (lastHashed?.hash) {
        log.lastHash = lastHashed.hash;
        break;
      }
    }
    return log;
  }

  /** An audit log whose entries go to a shared database instead of files. */
  static shared(sink: AuditSink): AuditLog {
    const log = new AuditLog(undefined, DEFAULT_MAX_BYTES, DEFAULT_KEEP_FILES);
    log.sink = sink;
    return log;
  }

  /**
   * Add an entry. Returns at once; the write is queued in the background.
   * @param input What happened. `detail` is redacted before it is stored.
   * @returns The finished entry, with its chain hashes.
   */
  record(input: AuditInput): AuditEntry {
    const base: AuditEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...input,
      // Redact before hashing and storing so secrets never reach disk, and
      // the hash covers exactly what is stored.
      ...(input.detail === undefined ? {} : { detail: redact(input.detail) }),
      prev: this.lastHash,
    };
    // The chain head moves synchronously, so concurrent requests get a
    // consistent order even though disk writes finish later.
    const entry: AuditEntry = { ...base, hash: hashEntry(base) };
    this.lastHash = entry.hash as string;
    this.total += 1;
    this.recent.push(entry);
    if (this.recent.length > KEEP_IN_MEMORY) {
      this.recent.shift();
    }

    // Failed writes are dropped, not thrown: an audit hiccup must not fail
    // the user's request.
    if (this.sink) {
      const sink = this.sink;
      this.pending = this.pending
        .then(() => sink.append(entry))
        .catch(() => undefined);
    } else if (this.path) {
      const line = JSON.stringify(entry) + '\n';
      // Writes are queued so lines never interleave and rotation never races an
      // append.
      // A failed write must not break the request.
      this.pending = this.pending
        .then(() => this.append(line))
        .catch(() => undefined);
    }
    return entry;
  }

  /** Newest first. */
  latest(limit = 50): AuditEntry[] {
    return this.recent.slice(-limit).reverse();
  }

  /**
   * Newest first. With shared state this includes what other gateways wrote.
   */
  async latestAny(limit = 50): Promise<AuditEntry[]> {
    if (!this.sink) {
      return this.latest(limit);
    }
    await this.flush();
    return this.sink.latest(limit);
  }

  /** How many entries were written since the gateway started. */
  get written(): number {
    return this.total;
  }

  /** Wait for queued writes (used on shutdown and in tests). */
  async flush(): Promise<void> {
    await this.pending;
  }

  /** Check the whole chain on disk, oldest file first. */
  async verify(): Promise<AuditVerification> {
    await this.flush();
    const result: AuditVerification = {
      ok: true,
      checked: 0,
      unchained: 0,
      completeHistory: false,
    };
    if (this.sink) {
      return verifyChains(this.sink, result);
    }
    if (!this.path) {
      return result;
    }

    const files: string[] = [];
    for (let i = this.keepFiles; i >= 1; i--) {
      files.push(`${this.path}.${i}`);
    }
    files.push(this.path);

    let expectedPrev: string | undefined;
    for (const file of files) {
      let lineNumber = 0;
      for await (const raw of linesOf(file)) {
        lineNumber += 1;
        if (!raw) {
          continue;
        }
        let entry: AuditEntry;
        try {
          entry = JSON.parse(raw) as AuditEntry;
        } catch {
          return fail(
            result,
            file,
            lineNumber,
            undefined,
            'line is not valid JSON',
          );
        }
        if (!entry.hash || !entry.prev) {
          if (expectedPrev !== undefined) {
            return fail(
              result,
              file,
              lineNumber,
              entry.id,
              'entry without a hash after the chain started',
            );
          }
          result.unchained += 1;
          continue;
        }
        if (expectedPrev === undefined) {
          result.completeHistory = entry.prev === GENESIS;
          result.firstAt = entry.at;
        } else if (entry.prev !== expectedPrev) {
          return fail(
            result,
            file,
            lineNumber,
            entry.id,
            'an entry is missing, moved or changed before this one',
          );
        }
        if (hashEntry(entry) !== entry.hash) {
          return fail(
            result,
            file,
            lineNumber,
            entry.id,
            'entry content does not match its hash',
          );
        }
        expectedPrev = entry.hash;
        result.checked += 1;
        result.lastAt = entry.at;
      }
    }
    return result;
  }

  /** Write one line, rotating first if it would pass the size limit. */
  private async append(line: string): Promise<void> {
    const path = this.path as string;
    const bytes = Buffer.byteLength(line);
    if (this.size > 0 && this.size + bytes > this.maxBytes) {
      await this.rotate(path);
    }
    await appendFile(path, line, { mode: 0o600 });
    this.size += bytes;
  }

  /**
   * Shift audit.log -> .1 -> .2 ... and drop the oldest. The chain carries
   * on in the new file because `lastHash` is kept in memory.
   */
  private async rotate(path: string): Promise<void> {
    await rm(`${path}.${this.keepFiles}`, { force: true });
    for (let i = this.keepFiles - 1; i >= 1; i--) {
      await rename(`${path}.${i}`, `${path}.${i + 1}`).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        },
      );
    }
    await rename(path, `${path}.1`);
    this.size = 0;
  }
}

/**
 * Check every chain in the shared table. Each chain starts at the genesis hash.
 */
async function verifyChains(
  sink: AuditSink,
  result: AuditVerification,
): Promise<AuditVerification> {
  let complete = true;
  for await (const { chain, entries } of sink.chains()) {
    let expectedPrev: string | undefined;
    let line = 0;
    for (const entry of entries) {
      line += 1;
      if (!entry.hash || !entry.prev) {
        return fail(
          result,
          `chain ${chain}`,
          line,
          entry.id,
          'entry without a hash',
        );
      }
      if (expectedPrev === undefined) {
        if (entry.prev !== GENESIS) {
          complete = false;
        }
      } else if (entry.prev !== expectedPrev) {
        return fail(
          result,
          `chain ${chain}`,
          line,
          entry.id,
          'an entry is missing, moved or changed before this one',
        );
      }
      if (hashEntry(entry) !== entry.hash) {
        return fail(
          result,
          `chain ${chain}`,
          line,
          entry.id,
          'entry content does not match its hash',
        );
      }
      expectedPrev = entry.hash;
      result.checked += 1;
      if (!result.firstAt || entry.at < result.firstAt) {
        result.firstAt = entry.at;
      }
      if (!result.lastAt || entry.at > result.lastAt) {
        result.lastAt = entry.at;
      }
    }
  }
  result.completeHistory = complete;
  return result;
}

/** Build a failed verification result pointing at the first bad line. */
function fail(
  result: AuditVerification,
  file: string,
  line: number,
  id: string | undefined,
  reason: string,
): AuditVerification {
  return {
    ...result,
    ok: false,
    brokenAt: {
      file: file.split('/').pop() as string,
      line,
      ...(id ? { id } : {}),
      reason,
    },
  };
}

/** Stream a file line by line; a missing file yields nothing. */
async function* linesOf(file: string): AsyncGenerator<string> {
  try {
    await stat(file);
  } catch {
    return;
  }
  const reader = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    yield line;
  }
}

/** Read a whole file as non-empty lines; missing file gives none. */
async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/** Parse one JSON line, skipping damaged ones instead of failing. */
function parseLine(line: string): AuditEntry[] {
  try {
    return [JSON.parse(line) as AuditEntry];
  } catch {
    return [];
  }
}
