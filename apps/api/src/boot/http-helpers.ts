/**
 * Small HTTP helpers for the gateway's request pipeline: caller address,
 * CORS, trace ids and metric labels.
 */
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { errors, isSethuError } from '@sethucms/core';
import { API_SECURITY_HEADERS } from '../http/respond.js';
import { type Logger } from '../logger.js';

/**
 * Caller address used for rate limiting and abuse logs.
 * Honours X-Forwarded-For only when `trustProxy` is set; otherwise any client
 * could pick its own address and escape the IP limit.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      ?.trim();
    if (first) {
      return first.slice(0, 64);
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Echo the Origin back only when it is on the allow list. Never use "*",
 * because requests carry bearer tokens.
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: Set<string>,
): void {
  // Tell caches the response depends on Origin.
  res.setHeader('Vary', 'Origin');
  const origin = req.headers['origin'];
  if (typeof origin !== 'string' || !allowed.has(origin)) {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  );
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Idempotency-Key, X-File-Name, X-File-Access',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-Request-Id, Retry-After, Idempotent-Replay',
  );
}

/** HTTP methods allowed as metric labels. */
const KNOWN_METHODS = new Set([
  'GET',
  'POST',
  'PATCH',
  'PUT',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
/**
 * Map unknown methods to "OTHER" so attackers cannot create unlimited
 * metric label values (cardinality blow-up).
 */
export const knownMethod = (method: string | undefined): string =>
  method && KNOWN_METHODS.has(method) ? method : 'OTHER';

/**
 * The trace id from a W3C `traceparent` header (00-<trace id>-<span
 * id>-<flags>), or undefined.
 */
export function traceIdOf(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(
    value ?? '',
  );
  return match && match[1] !== '0'.repeat(32) ? match[1] : undefined;
}

/**
 * Log server faults with their internal cause; expected client errors are
 * skipped.
 */
export function logIfUnexpected(
  logger: Logger,
  error: unknown,
  requestId: string,
): void {
  if (isSethuError(error) && error.code !== 'INTERNAL') {
    return;
  }
  // Server-side only: the cause can contain database messages that clients must
  // never see.
  const cause =
    error instanceof Error
      ? error.cause instanceof Error
        ? error.cause
        : error
      : undefined;
  logger.error({
    event: 'error.unexpected',
    requestId,
    message: 'Unexpected error',
    error: cause?.message,
    stack: cause?.stack,
  });
}

// Re-exported so tests and tools can check the standard headers.
export { API_SECURITY_HEADERS };
