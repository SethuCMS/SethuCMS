import type { AuditLog } from '../audit.js';
import type { Authenticator } from '../auth.js';
import type { ConnectionRegistry } from '../connections/registry.js';
import type { DraftsService } from '../content/drafts.js';
import type { RecordsService } from '../content/records.js';
import type { EventBus } from '../events.js';
import type { Metrics } from '../metrics.js';
import type { MigrationManager } from '../migration/manager.js';
import type { Router } from '../http/router.js';
import type { StateStore } from '../store/state.js';
import type { ChangeStore } from '../changes/store.js';

/** Everything route handlers need. Built once in gateway.ts. */
export interface Services {
  router: Router;
  store: StateStore;
  auth: Authenticator;
  registry: ConnectionRegistry;
  records: RecordsService;
  drafts: DraftsService;
  audit: AuditLog;
  events: EventBus;
  /** Open event streams, to cap how many a caller can hold. */
  streams: StreamCounter;
  metrics: Metrics;
  migrations: MigrationManager;
  /** The numbered change feed and the webhook delivery queue. */
  changes: ChangeStore;
  /** Optional separate token for metrics scrapers. */
  metricsToken: string | undefined;
}

export class StreamCounter {
  private total = 0;

  /** Event streams open right now. */
  get open(): number {
    return this.total;
  }
  private readonly perCaller = new Map<string, number>();

  constructor(
    private readonly maxTotal = 200,
    private readonly maxPerCaller = 8,
  ) {}

  /** Returns a release function, or null when the limit is reached. */
  acquire(caller: string): (() => void) | null {
    const mine = this.perCaller.get(caller) ?? 0;
    if (this.total >= this.maxTotal || mine >= this.maxPerCaller) {
      return null;
    }
    this.total += 1;
    this.perCaller.set(caller, mine + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.total -= 1;
      const left = (this.perCaller.get(caller) ?? 1) - 1;
      if (left <= 0) {
        this.perCaller.delete(caller);
      } else {
        this.perCaller.set(caller, left);
      }
    };
  }
}
