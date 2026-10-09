/**
 * Helpers for writing JSON answers and reading JSON request bodies.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { errors, toApiError } from '@sethucms/core';

/**
 * Headers added to every answer. The API only serves JSON, so the policy is
 * strict.
 */
export const API_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

/**
 * Write a JSON response with the strict API security headers.
 *
 * @param res Node response; ignored if headers were already sent.
 * @param status HTTP status. 204 sends no body.
 * @param body Value to serialise; `undefined` means no body.
 * @param headers Extra headers, which may override the defaults.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...API_SECURITY_HEADERS,
    ...headers,
    ...(text
      ? {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(text),
        }
      : {}),
  });
  res.end(status === 204 ? undefined : text);
}

/** The status, JSON body and headers for an error answer. */
export interface ErrorResponse {
  status: number;
  body: {
    error: {
      code: string;
      message: string;
      details?: unknown;
      requestId: string;
    };
  };
  headers: Record<string, string>;
}

/**
 * Turn anything thrown into the standard error body. Internal details never
 * leave the server.
 */
export function errorResponse(
  error: unknown,
  requestId: string,
): ErrorResponse {
  const api = toApiError(error);
  const headers: Record<string, string> = {};
  // Tell rate-limited clients how long to back off.
  if (
    api.error.code === 'RATE_LIMITED' &&
    typeof api.error.details === 'object' &&
    api.error.details !== null
  ) {
    const wait = (api.error.details as { retryAfter?: unknown }).retryAfter;
    if (typeof wait === 'number') {
      headers['Retry-After'] = String(wait);
    }
  }
  return {
    status: api.status,
    body: { error: { ...api.error, requestId } },
    headers,
  };
}

// 1 MiB cap stops memory exhaustion from oversized bodies.
const MAX_BODY_BYTES = 1_048_576;

/**
 * Read a JSON body with a size limit.
 *
 * @param req Incoming request.
 * @returns The parsed body.
 * @throws A validation error for a wrong content type, or a body that is
 *   too large, empty or not valid JSON.
 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
  // Strict content type check; forcing JSON blocks simple cross-site form
  // posts, which browsers can send without a CORS preflight.
  const type = (req.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (type !== 'application/json') {
    throw errors.validation('Content-Type must be application/json');
  }

  // Cheap early reject from the header; it can lie, so the stream is
  // counted again below.
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) {
    throw errors.validation('Request body is too large');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw errors.validation('Request body is too large');
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) {
    throw errors.validation('Request body is empty');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw errors.validation('Request body is not valid JSON');
  }
}
