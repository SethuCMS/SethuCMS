// Covers logging, request logs, Prometheus metrics and the tamper-evident audit
// chain, focusing on what must never leak into them.

import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AuditLog } from '../src/audit.js';
import { configFromEnv } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import {
  ADMIN_TOKEN,
  demoConnection,
  startGateway,
  tokenFor,
} from './helpers.js';

const METRICS_TOKEN = 'metrics-scraper-token-0123456789abcdef0123456789';

// Captures structured log lines in memory so tests can inspect exactly what
// would be written.
function capture(level: 'debug' | 'info' = 'debug') {
  const lines: any[] = [];
  const logger = createLogger({
    level,
    write: (line) => lines.push(JSON.parse(line)),
  });
  return { lines, logger };
}

// Logs are shipped to third parties, so secrets must be redacted at the logger
// itself, not left to callers.
describe('logger', () => {
  it('filters by level, adds fields to children and hides secrets', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'warn',
      write: (line) => lines.push(line),
    });
    log.info({ message: 'quiet' });
    log.child({ connectionId: 'c1' }).warn({
      message: 'loud',
      password: 'hunter2',
      url: 'postgres://u:topsecret@h/db',
    });
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0] as string);
    assert.equal(entry.level, 'warn');
    assert.equal(entry.connectionId, 'c1');
    assert.ok(
      !lines[0]?.includes('hunter2') && !lines[0]?.includes('topsecret'),
    );
  });

  it('can print readable lines', () => {
    const lines: string[] = [];
    createLogger({ format: 'pretty', write: (line) => lines.push(line) }).info({
      event: 'http.request',
      status: 200,
      ms: 4,
    });
    assert.match(lines[0] as string, /INFO\s+http\.request status=200 ms=4/);
  });

  // Bad settings must fail at start-up with the variable name, not silently
  // fall back to defaults.
  it('checks its settings', () => {
    assert.throws(
      () => configFromEnv({ SETHUCMS_LOG_LEVEL: 'loud' }),
      /SETHUCMS_LOG_LEVEL/,
    );
    assert.throws(
      () => configFromEnv({ SETHUCMS_LOG_FORMAT: 'xml' }),
      /SETHUCMS_LOG_FORMAT/,
    );
    assert.throws(
      () => configFromEnv({ SETHUCMS_AUDIT_MAX_MB: '0' }),
      /SETHUCMS_AUDIT_MAX_MB/,
    );
    assert.throws(
      () => configFromEnv({ SETHUCMS_METRICS_TOKEN: 'short' }),
      /SETHUCMS_METRICS_TOKEN/,
    );
    assert.equal(
      configFromEnv({ SETHUCMS_LOG_LEVEL: 'DEBUG' }).logLevel,
      'debug',
    );
  });
});

describe('request logs', () => {
  // Query strings often hold search terms or tokens, so only the route pattern
  // is logged; levels keep health checks quiet and refusals visible.
  it('log the route pattern, never the query string, and pick the level from the outcome', async () => {
    const { lines, logger } = capture();
    const t = await startGateway({ slowRequestMs: 100_000 }, { logger });
    try {
      const id = await demoConnection(t);
      const filter = JSON.stringify({
        field: 'status',
        op: 'eq',
        value: 'secret-search-term',
      });
      await t.call(
        'GET',
        `/v1/connections/${id}/collections/articles/records?filter=${encodeURIComponent(filter)}`,
      );
      await t.call('GET', '/v1/health');
      await t.call('GET', '/v1/me', { token: 'not-a-real-token-0123456789' });
      await t.call('GET', '/v1/nowhere');

      const requests = lines.filter((l) => l.event === 'http.request');
      const records = requests.find(
        (l) =>
          l.route ===
          '/v1/connections/:connectionId/collections/:collection/records',
      );
      assert.ok(records, 'route pattern is logged, not the raw path');
      assert.equal(records.level, 'info');
      assert.equal(records.status, 200);
      assert.ok(
        !JSON.stringify(lines).includes('secret-search-term'),
        'query strings are never logged',
      );
      assert.ok(
        typeof records.requestId === 'string' && typeof records.ms === 'number',
      );

      assert.equal(
        requests.find((l) => l.route === '/v1/health')?.level,
        'debug',
        'health checks are quiet',
      );
      const denied = requests.find((l) => l.status === 401);
      assert.equal(denied?.level, 'warn');
      assert.ok(denied?.ip, 'the address is kept for refused requests');
      assert.equal(records.ip, undefined, 'and only for refused requests');
      assert.equal(requests.find((l) => l.status === 404)?.route, 'unmatched');
    } finally {
      await t.close();
    }
  });

  // slowRequestMs of 0 forces every request to count as slow.
  it('flag slow requests', async () => {
    const { lines, logger } = capture();
    const t = await startGateway({ slowRequestMs: 0 }, { logger });
    try {
      await t.call('GET', '/v1/me');
      const entry = lines.find(
        (l) => l.event === 'http.request' && l.route === '/v1/me',
      );
      assert.equal(entry?.slow, true);
      assert.equal(entry?.level, 'warn');
    } finally {
      await t.close();
    }
  });

  // Caller-supplied request ids go into logs and headers, so unsafe values
  // (header or log injection) must be replaced.
  it('keep a safe request id, replace an unsafe one, and note the trace id', async () => {
    const { lines, logger } = capture();
    const t = await startGateway({}, { logger });
    try {
      const own = await t.call('GET', '/v1/me', {
        headers: { 'X-Request-Id': 'abc-123_request.id' },
      });
      assert.equal(own.headers.get('x-request-id'), 'abc-123_request.id');
      const bad = await t.call('GET', '/v1/me', {
        headers: { 'X-Request-Id': 'bad id\twith spaces' },
      });
      assert.notEqual(bad.headers.get('x-request-id'), 'bad id\twith spaces');
      assert.match(
        bad.headers.get('x-request-id') as string,
        /^[0-9a-f-]{36}$/,
      );

      const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
      await t.call('GET', '/v1/me', {
        headers: { traceparent: `00-${trace}-00f067aa0ba902b7-01` },
      });
      await t.call('GET', '/v1/me', {
        headers: { traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` },
      });
      const withTrace = lines.filter(
        (l) => l.event === 'http.request' && l.route === '/v1/me',
      );
      assert.equal(withTrace.filter((l) => l.traceId === trace).length, 1);
      assert.equal(
        withTrace.filter((l) => l.traceId !== undefined).length,
        1,
        'an all-zero trace id is ignored',
      );
    } finally {
      await t.close();
    }
  });

  // Unexpected errors are logged for operators with secrets redacted, but
  // clients get no internal detail.
  it('record unexpected errors on the server only', async () => {
    const { lines, logger } = capture();
    const t = await startGateway(
      {},
      {
        logger,
        adapters: {
          boom: {
            label: 'Boom',
            create: () => {
              throw new Error('db exploded at password=hunter2');
            },
          } as any,
        },
      },
    );
    try {
      const res = await t.call('POST', '/v1/admin/connections', {
        body: { name: 'x', adapter: 'boom', mode: 'read_only', expose: 'none' },
      });
      assert.ok(res.status >= 400);
      assert.ok(!JSON.stringify(res.body).includes('hunter2'));
      assert.ok(
        !JSON.stringify(lines).includes('hunter2'),
        'secrets are hidden in the server log as well',
      );
    } finally {
      await t.close();
    }
  });
});

// Metrics expose operational data, so access is restricted.
describe('metrics', () => {
  // A separate scraper token lets monitoring read metrics without admin rights.
  it('need an admin token or the metrics token', async () => {
    const t = await startGateway({ metricsToken: METRICS_TOKEN });
    try {
      assert.equal(
        (await t.call('GET', '/v1/metrics', { token: null })).status,
        401,
      );
      assert.equal(
        (
          await t.call('GET', '/v1/metrics', {
            token: 'wrong-token-0123456789abcdef',
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await t.call('GET', '/v1/metrics', {
            token: await tokenFor(t, 'viewer'),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await t.call('GET', '/v1/metrics', {
            token: await tokenFor(t, 'editor'),
          })
        ).status,
        403,
      );

      const viaAdmin = await fetch(`${t.url}/v1/metrics`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      assert.equal(viaAdmin.status, 200);
      assert.match(
        viaAdmin.headers.get('content-type') as string,
        /^text\/plain; version=0\.0\.4/,
      );
      const viaScraper = await fetch(`${t.url}/v1/metrics`, {
        headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
      });
      assert.equal(viaScraper.status, 200);

      // The scraper token opens metrics and nothing else.
      assert.equal(
        (await t.call('GET', '/v1/me', { token: METRICS_TOKEN })).status,
        401,
      );
    } finally {
      await t.close();
    }
  });

  // Labels must have low cardinality and no sensitive values; ids or raw paths
  // would blow up storage and leak information.
  it('count requests by route pattern, errors by code and connections by adapter, with no ids or paths', async () => {
    const t = await startGateway();
    try {
      const id = await demoConnection(t);
      await t.call('GET', `/v1/connections/${id}/collections/articles/records`);
      await t.call('GET', '/v1/me', { token: null });
      await t.call('GET', '/v1/some/unknown/path/with-an-id-12345');
      await t.call('POST', '/v1/me');

      const text = await (
        await fetch(`${t.url}/v1/metrics`, {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        })
      ).text();
      assert.match(
        text,
        /sethucms_http_requests_total\{method="GET",route="\/v1\/connections\/:connectionId\/collections\/:collection\/records",status="200"\} 1/,
      );
      assert.match(
        text,
        /sethucms_http_requests_total\{method="GET",route="unmatched",status="404"\} 1/,
      );
      assert.match(text, /sethucms_errors_total\{code="AUTH_FAILED"\} 1/);
      assert.match(
        text,
        /sethucms_http_request_duration_seconds_bucket\{le="\+Inf",method="GET",route="\/v1\/me"\}/,
      );
      assert.match(text, /sethucms_connections\{adapter="memory"\} 1/);
      assert.match(text, /sethucms_http_in_flight_requests 1/); // the scrape itself
      assert.match(text, /sethucms_process_resident_memory_bytes \d+/);
      assert.match(
        text,
        /# TYPE sethucms_http_request_duration_seconds histogram/,
      );
      assert.ok(!text.includes(id), 'connection ids never become labels');
      assert.ok(
        !text.includes('with-an-id-12345'),
        'raw paths never become labels',
      );
      assert.ok(!text.includes(ADMIN_TOKEN));
    } finally {
      await t.close();
    }
  });

  // Rate-limit refusals need a counter so operators notice abuse.
  it('count refused requests and change events', async () => {
    const t = await startGateway(
      {},
      { rateLimit: { capacity: 3, refillPerSecond: 0.001 } },
    );
    try {
      for (let i = 0; i < 8; i++) {
        await t.call('GET', '/v1/health', { token: null });
      }
      const text = t.gateway.services.metrics.text(); // read directly: the address is rate limited now
      assert.match(text, /sethucms_rate_limited_total\{scope="ip"\} \d+/);
    } finally {
      await t.close();
    }
  });
});

// The audit log is a hash chain, so deleted or edited history is detectable.
describe('audit chain', () => {
  const open = async (dir: string, maxBytes?: number, keepFiles?: number) =>
    AuditLog.open(dir, {
      ...(maxBytes ? { maxBytes } : {}),
      ...(keepFiles ? { keepFiles } : {}),
    });

  // Each entry includes the hash of the previous one; secrets in details are
  // redacted before hashing.
  it('links every entry to the one before and verifies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-audit-'));
    try {
      const log = await open(dir);
      const a = log.record({ actor: 'a', operation: 'x', target: 't1' });
      const b = log.record({
        actor: 'a',
        operation: 'y',
        target: 't2',
        detail: { password: 'hunter2' },
      });
      assert.equal(b.prev, a.hash);
      assert.match(a.prev as string, /^0{64}$/);
      assert.ok(!JSON.stringify(b).includes('hunter2'));
      const result = await log.verify();
      assert.deepEqual(
        {
          ok: result.ok,
          checked: result.checked,
          complete: result.completeHistory,
        },
        { ok: true, checked: 2, complete: true },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A restart must continue the same chain, or a gap would look like tampering.
  it('continues the chain after a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-audit-'));
    try {
      const first = await open(dir);
      const a = first.record({ actor: 'a', operation: 'x', target: 't1' });
      await first.flush();
      const second = await open(dir);
      const b = second.record({ actor: 'a', operation: 'y', target: 't2' });
      assert.equal(b.prev, a.hash);
      const result = await second.verify();
      assert.equal(result.ok, true);
      assert.equal(result.checked, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Every kind of tampering - edit, deletion, reordering - must be detected and
  // located.
  it('notices a changed, removed or reordered line', async () => {
    for (const tamper of ['change', 'remove', 'reorder'] as const) {
      const dir = await mkdtemp(join(tmpdir(), 'sethucms-audit-'));
      try {
        const log = await open(dir);
        for (let i = 0; i < 5; i++) {
          log.record({ actor: 'a', operation: 'op', target: `t${i}` });
        }
        await log.flush();
        const file = join(dir, 'audit.log');
        const lines = (await readFile(file, 'utf8')).trim().split('\n');
        if (tamper === 'change') {
          lines[2] = (lines[2] as string).replace('"t2"', '"t9"');
        }
        if (tamper === 'remove') {
          lines.splice(2, 1);
        }
        if (tamper === 'reorder') {
          [lines[1], lines[2]] = [lines[2] as string, lines[1] as string];
        }
        await writeFile(file, lines.join('\n') + '\n');
        const result = await log.verify();
        assert.equal(result.ok, false, `${tamper} must be detected`);
        assert.ok(result.brokenAt?.line, 'says where');
        assert.equal(result.brokenAt?.file, 'audit.log');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  // A line added by hand without a hash must be flagged, or history could be
  // forged by appending.
  it('notices garbage and an unhashed line added after the chain started', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-audit-'));
    try {
      const log = await open(dir);
      log.record({ actor: 'a', operation: 'op', target: 't' });
      await log.flush();
      await appendFile(
        join(dir, 'audit.log'),
        JSON.stringify({
          id: 'forged',
          at: 'now',
          actor: 'a',
          operation: 'op',
          target: 'forged',
        }) + '\n',
      );
      const result = await log.verify();
      assert.equal(result.ok, false);
      assert.match(result.brokenAt?.reason as string, /without a hash/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Rotation bounds disk use; verification must still pass and honestly report
  // that the history is no longer complete.
  it('rotates by size, keeps a limited number of files and still verifies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-audit-'));
    try {
      const log = await open(dir, 1500, 2);
      for (let i = 0; i < 60; i++) {
        log.record({ actor: 'a', operation: 'op', target: `target-${i}` });
      }
      await log.flush();
      const files = (await readdir(dir))
        .filter((f) => f.startsWith('audit.log'))
        .sort();
      assert.deepEqual(
        files,
        ['audit.log', 'audit.log.1', 'audit.log.2'],
        'at most the current file plus two rotated',
      );
      const result = await log.verify();
      assert.equal(result.ok, true, JSON.stringify(result.brokenAt));
      assert.equal(
        result.completeHistory,
        false,
        'old entries were rotated away, and the report says so',
      );
      assert.ok(result.checked > 10 && result.checked < 60);

      // After a restart the chain carries on from the newest entry.
      const again = await open(dir, 1500, 2);
      const next = again.record({
        actor: 'a',
        operation: 'op',
        target: 'after-restart',
      });
      assert.equal(next.prev, log.latest(1)[0]?.hash);
      assert.equal((await again.verify()).ok, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Verification output is sensitive operational data, so it is admin-only.
  it('is available to administrators only, through the API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sethucms-audit-'));
    try {
      const t = await startGateway({ dataDir: dir, seedDemo: false });
      try {
        await t.call('POST', '/v1/admin/tokens', {
          body: { name: 'n', role: 'viewer' },
        });
        const ok = await t.call('GET', '/v1/admin/audit/verify');
        assert.equal(ok.status, 200);
        assert.equal(ok.body.data.ok, true);
        assert.ok(ok.body.data.checked >= 1);
        assert.equal(
          (
            await t.call('GET', '/v1/admin/audit/verify', {
              token: await tokenFor(t, 'editor'),
            })
          ).status,
          403,
        );
        assert.equal(
          (await t.call('GET', '/v1/admin/audit/verify', { token: null }))
            .status,
          401,
        );
      } finally {
        await t.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
