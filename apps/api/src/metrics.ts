/**
 * Metrics in the Prometheus text format, with no extra dependency.
 *
 * Labels must come from small fixed sets (a route pattern, a status code, an
 * error code), never from user input such as ids or paths. Each metric stops
 * adding new label combinations after MAX_SERIES, so a bug cannot use up
 * memory.
 *
 * What is in here:
 *   - `Counter`: a value that only goes up (requests served, errors seen).
 *     `inc(labels, by)` adds to it.
 *   - `Histogram`: a distribution (such as request duration) in fixed,
 *     cumulative buckets, as Prometheus expects. `observe(labels, value)`.
 *   - `Metrics`: the registry for the whole process. It owns the well-known
 *     gateway metrics, registers built-in process gauges (memory, CPU,
 *     event-loop delay) and renders everything with `text()`. Gauges are
 *     read only at scrape time; one gauge that throws is skipped so it
 *     cannot break the scrape. Call `close()` on shutdown to stop the
 *     event-loop sampler.
 *   - Label values are escaped on output, so they cannot break a line or
 *     inject extra labels. Drops caused by the series cap are exported as
 *     `sethucms_metric_series_dropped_total`, so they are never silent.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

type Labels = Record<string, string>;
const MAX_SERIES = 500;

// Escape per the Prometheus text format so a label value cannot break a line
// or inject extra labels.
const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const keyOf = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((name) => `${name}=${labels[name]}`)
    .join('\u0000');
const render = (labels: Labels): string => {
  const names = Object.keys(labels).sort();
  return names.length === 0
    ? ''
    : `{${names.map((name) => `${name}="${escapeLabel(labels[name] as string)}"`).join(',')}}`;
};

class Series<T> {
  readonly values = new Map<string, { labels: Labels; value: T }>();
  dropped = 0;

  get(labels: Labels, create: () => T): T | undefined {
    const key = keyOf(labels);
    let entry = this.values.get(key);
    if (!entry) {
      if (this.values.size >= MAX_SERIES) {
        this.dropped += 1;
        return undefined;
      }
      entry = { labels: { ...labels }, value: create() };
      this.values.set(key, entry);
    }
    return entry.value;
  }
}

export class Counter {
  private readonly series = new Series<{ n: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1): void {
    const cell = this.series.get(labels, () => ({ n: 0 }));
    if (cell) {
      cell.n += by;
    }
  }
  lines(): string[] {
    return [...this.series.values.values()].map(
      (e) => `${this.name}${render(e.labels)} ${e.value.n}`,
    );
  }
  get dropped(): number {
    return this.series.dropped;
  }
}

export class Histogram {
  private readonly series = new Series<{
    counts: number[];
    sum: number;
    count: number;
  }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: number[],
  ) {}
  observe(labels: Labels, value: number): void {
    const cell = this.series.get(labels, () => ({
      counts: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    }));
    if (!cell) {
      return;
    }
    cell.sum += value;
    cell.count += 1;
    this.buckets.forEach((limit, i) => {
      if (value <= limit) {
        cell.counts[i] = (cell.counts[i] as number) + 1;
      }
    });
  }
  lines(): string[] {
    const out: string[] = [];
    for (const { labels, value } of this.series.values.values()) {
      this.buckets.forEach((limit, i) =>
        out.push(
          `${this.name}_bucket${render({ ...labels, le: String(limit) })} ${value.counts[i]}`,
        ),
      );
      out.push(
        `${this.name}_bucket${render({ ...labels, le: '+Inf' })} ${value.count}`,
      );
      out.push(`${this.name}_sum${render(labels)} ${value.sum}`);
      out.push(`${this.name}_count${render(labels)} ${value.count}`);
    }
    return out;
  }
}

type Sample = number | Array<{ labels: Labels; value: number }>;

export class Metrics {
  private readonly counters: Counter[] = [];
  private readonly histograms: Histogram[] = [];
  private readonly collected: Array<{
    name: string;
    help: string;
    type: 'gauge' | 'counter';
    collect: () => Sample;
  }> = [];
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly startedAt = Date.now();

  readonly httpRequests = this.counter(
    'sethucms_http_requests_total',
    'HTTP requests by method, route pattern and status code.',
  );
  readonly httpDuration = this.histogram(
    'sethucms_http_request_duration_seconds',
    'Time to answer a request (streams excluded).',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  );
  readonly errors = this.counter(
    'sethucms_errors_total',
    'Error answers by error code.',
  );
  readonly rateLimited = this.counter(
    'sethucms_rate_limited_total',
    'Requests refused by a rate limit, by scope (ip, caller, expensive).',
  );
  readonly migrationRecords = this.counter(
    'sethucms_migration_records_total',
    'Records handled by migrations, by result (created, updated, skipped, failed).',
  );
  readonly events = this.counter(
    'sethucms_events_total',
    'Change events published, by type.',
  );
  inFlight = 0;

  constructor() {
    this.loopDelay.enable();
    this.gauge(
      'sethucms_http_in_flight_requests',
      'Requests being handled right now.',
      () => this.inFlight,
    );
    this.gauge(
      'sethucms_process_uptime_seconds',
      'Seconds since the gateway started.',
      () => (Date.now() - this.startedAt) / 1000,
    );
    this.gauge(
      'sethucms_process_resident_memory_bytes',
      'Resident memory.',
      () => process.memoryUsage().rss,
    );
    this.gauge(
      'sethucms_process_heap_used_bytes',
      'Used JavaScript heap.',
      () => process.memoryUsage().heapUsed,
    );
    this.gauge(
      'sethucms_process_cpu_user_seconds_total',
      'CPU time in user code.',
      () => process.cpuUsage().user / 1e6,
      'counter',
    );
    this.gauge(
      'sethucms_process_cpu_system_seconds_total',
      'CPU time in the system.',
      () => process.cpuUsage().system / 1e6,
      'counter',
    );
    this.gauge(
      'sethucms_event_loop_delay_p99_seconds',
      'Event loop delay, 99th percentile. High values mean the process is overloaded.',
      () => this.loopDelay.percentile(99) / 1e9,
    );
    this.gauge(
      'sethucms_build_info',
      'Always 1. The label shows the Node.js version.',
      () => [{ labels: { node: process.version }, value: 1 }],
    );
  }

  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.counters.push(c);
    return c;
  }
  histogram(name: string, help: string, buckets: number[]): Histogram {
    const h = new Histogram(name, help, buckets);
    this.histograms.push(h);
    return h;
  }
  /** A value read at scrape time. */
  gauge(
    name: string,
    help: string,
    collect: () => Sample,
    type: 'gauge' | 'counter' = 'gauge',
  ): void {
    this.collected.push({ name, help, type, collect });
  }

  text(): string {
    const out: string[] = [];
    for (const c of this.counters) {
      out.push(
        `# HELP ${c.name} ${c.help}`,
        `# TYPE ${c.name} counter`,
        ...c.lines(),
      );
    }
    for (const h of this.histograms) {
      out.push(
        `# HELP ${h.name} ${h.help}`,
        `# TYPE ${h.name} histogram`,
        ...h.lines(),
      );
    }
    for (const g of this.collected) {
      let sample: Sample;
      try {
        sample = g.collect();
      } catch {
        continue; // one broken gauge must not break the scrape
      }
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} ${g.type}`);
      if (typeof sample === 'number') {
        out.push(`${g.name} ${sample}`);
      } else {
        for (const s of sample) {
          out.push(`${g.name}${render(s.labels)} ${s.value}`);
        }
      }
    }
    const dropped = [...this.counters].reduce((sum, c) => sum + c.dropped, 0);
    out.push(
      '# HELP sethucms_metric_series_dropped_total Label combinations ignored because a metric reached its limit.',
      '# TYPE sethucms_metric_series_dropped_total counter',
      `sethucms_metric_series_dropped_total ${dropped}`,
    );
    return out.join('\n') + '\n';
  }

  close(): void {
    this.loopDelay.disable();
  }
}
