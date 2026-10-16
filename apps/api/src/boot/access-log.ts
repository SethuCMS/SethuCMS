/**
 * The end of every request: metrics and one log line.
 */
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type Principal } from '../auth.js';
import { type Logger } from '../logger.js';
import { Metrics } from '../metrics.js';
import { knownMethod } from './http-helpers.js';
/** What the request pipeline knows when a request ends. */
export interface FinishedRequest {
  metrics: Metrics;
  logger: Logger;
  slowMs: number;
  req: IncomingMessage;
  res: ServerResponse;
  started: number;
  routeLabel: string;
  requestId: string;
  traceId: string | undefined;
  principal: Principal | undefined;
  ip: string;
}

/** Count the request and write its one structured log line. */
export function recordRequest(done: FinishedRequest): void {
  const {
    metrics,
    logger,
    slowMs,
    req,
    res,
    started,
    routeLabel,
    requestId,
    traceId,
    principal,
    ip,
  } = done;
  metrics.inFlight -= 1;
  const ms = Date.now() - started;
  const status = res.statusCode;
  const streaming = String(res.getHeader('content-type') ?? '').startsWith(
    'text/event-stream',
  );
  metrics.httpRequests.inc({
    method: knownMethod(req.method),
    route: routeLabel,
    status: String(status),
  });
  if (!streaming) {
    metrics.httpDuration.observe(
      { method: knownMethod(req.method), route: routeLabel },
      ms / 1000,
    );
  }

  const slow = !streaming && ms >= slowMs;
  // Auth failures and rate limits are logged at warn so abuse stands out.
  const security = status === 401 || status === 403 || status === 429;
  const level =
    status >= 500
      ? 'error'
      : security || slow
        ? 'warn'
        : routeLabel === '/v1/health' || routeLabel === '/v1/ready'
          ? 'debug'
          : 'info';
  // No query string (filters can hold personal data) and no body. The
  // address is logged only
  // for refused requests, where it is needed to spot abuse.
  logger[level]({
    event: 'http.request',
    requestId,
    ...(traceId ? { traceId } : {}),
    method: req.method,
    path: (req.url ?? '').split('?')[0],
    route: routeLabel,
    status,
    ms,
    ...(slow ? { slow: true } : {}),
    caller: principal?.id,
    role: principal?.role,
    ...(security ? { ip } : {}),
  });
}
