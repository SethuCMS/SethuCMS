/**
 * One error type for the whole platform.
 *
 * Each error has a stable code and an HTTP status. This keeps error
 * responses consistent across database adapters.
 */
/** Every stable error code the platform can return to clients. */
export const ERROR_CODES = [
  'CONNECTION_FAILED',
  'AUTH_FAILED',
  'FORBIDDEN',
  'READ_ONLY',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_FAILED',
  'CAPABILITY_UNSUPPORTED',
  'RATE_LIMITED',
  'TIMEOUT',
  'INTERNAL',
] as const;

/** Union of the values in {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status sent for each error code. */
export const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  AUTH_FAILED: 401,
  FORBIDDEN: 403,
  READ_ONLY: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  CAPABILITY_UNSUPPORTED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  CONNECTION_FAILED: 502,
  TIMEOUT: 504,
};

/**
 * One validation problem.
 *
 * @property path Location of the bad value, e.g. `filter.age`.
 * @property message Human-readable reason.
 */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Error carrying a stable code, an HTTP status and optional details.
 *
 * @property code Machine-readable error code.
 * @property details Extra data safe to show the caller (e.g. issues).
 */
export class SethuError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  /**
   * @param code Error code; also decides the HTTP status.
   * @param message Message that may be shown to API clients.
   * @param details Optional structured data for the client.
   * @param options Standard `cause`, kept for server-side logs.
   */
  constructor(
    code: ErrorCode,
    message: string,
    details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SethuError';
    this.code = code;
    this.details = details;
  }

  /** HTTP status derived from the error code. */
  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

/** Type guard for {@link SethuError}. */
export const isSethuError = (e: unknown): e is SethuError =>
  e instanceof SethuError;

/** Factory helpers, one per error code, with sensible default messages. */
export const errors = {
  connectionFailed: (m = 'Connection failed', d?: unknown) =>
    new SethuError('CONNECTION_FAILED', m, d),

  authFailed: (m = 'Authentication failed', d?: unknown) =>
    new SethuError('AUTH_FAILED', m, d),

  forbidden: (m = 'Forbidden', d?: unknown) =>
    new SethuError('FORBIDDEN', m, d),

  readOnly: (m = 'Connection is read-only', d?: unknown) =>
    new SethuError('READ_ONLY', m, d),

  notFound: (m = 'Not found', d?: unknown) => new SethuError('NOT_FOUND', m, d),

  conflict: (m = 'Conflict', d?: unknown) => new SethuError('CONFLICT', m, d),

  validation: (m: string, issues?: ValidationIssue[]) =>
    new SethuError('VALIDATION_FAILED', m, issues),

  unsupported: (m: string, d?: unknown) =>
    new SethuError('CAPABILITY_UNSUPPORTED', m, d),

  rateLimited: (m = 'Rate limited', d?: unknown) =>
    new SethuError('RATE_LIMITED', m, d),

  timeout: (m = 'Timed out', d?: unknown) => new SethuError('TIMEOUT', m, d),

  // `cause` is kept for logging but never sent to clients (see toApiError).
  internal: (m = 'Internal error', d?: unknown, cause?: unknown) =>
    new SethuError('INTERNAL', m, d, { cause }),
};

/**
 * Throws a VALIDATION_FAILED error if any issues were collected.
 *
 * @param issues Problems gathered so far; empty means valid.
 * @param message Summary message for the error.
 * @throws SethuError with the issues as `details`.
 */
export function throwIfIssues(
  issues: ValidationIssue[],
  message = 'Validation failed',
): void {
  if (issues.length > 0) {
    throw errors.validation(message, issues);
  }
}

/** Shape of an error response body, plus its HTTP status. */
export interface ApiError {
  status: number;
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}

/**
 * Converts thrown errors into API responses without exposing
 * internal error details.
 */
export function toApiError(e: unknown): ApiError {
  // Unknown errors may carry stack traces or secrets, so only a generic message
  // is returned.
  if (!isSethuError(e)) {
    return {
      status: 500,
      error: {
        code: 'INTERNAL',
        message: 'Internal error',
      },
    };
  }

  // Even our own INTERNAL errors get a generic message; their real message is
  // for server logs only.
  if (e.code === 'INTERNAL') {
    return {
      status: 500,
      error: {
        code: 'INTERNAL',
        message: 'Internal error',
      },
    };
  }

  return {
    status: e.status,
    error: {
      code: e.code,
      message: e.message,
      ...(e.details !== undefined ? { details: e.details } : {}),
    },
  };
}
