/**
 * A tiny router: match a method and path, collect `:params`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../auth.js';

/** Everything a route handler gets for one request. */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  /** Set for routes that need a signed-in caller. */
  principal: Principal;
  /** Remote address, for rate limiting and logs. */
  ip: string;
  /** Read and parse the JSON body (at most 1 MB). */
  json(): Promise<unknown>;
}

/**
 * What a route returns. Streaming routes write to `res` themselves and return
 * "handled".
 */
export type RouteResult =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | 'handled';

/** A route handler; may be sync or async. */
export type Handler = (
  ctx: RequestContext,
) => Promise<RouteResult> | RouteResult;

/** One endpoint: method, path pattern and how it is guarded. */
export interface Route {
  method: string;
  pattern: string;
  /** "none" routes run without a token (health checks, preview links). */
  auth: 'none' | 'token';
  handler: Handler;
  /** Writes can be retried safely with an Idempotency-Key. */
  idempotent?: boolean;
  /** Count against the stricter limit for expensive calls. */
  expensive?: boolean;
}

// Pattern pre-split once so matching does no string work per route.
interface Compiled extends Route {
  segments: string[];
}

/**
 * Ordered list of routes. First match wins, so register specific patterns
 * before general ones.
 */
export class Router {
  private readonly routes: Compiled[] = [];

  /** Register a route. `pattern` uses `:name` for path parameters. */
  add(route: Route): void {
    this.routes.push({
      ...route,
      segments: route.pattern.split('/').filter(Boolean),
    });
  }

  /**
   * Find the route for a request. Distinguishes "no such path" from "wrong
   * method".
   */
  match(
    method: string,
    pathname: string,
  ):
    | { route: Route; params: Record<string, string> }
    | { allowed: string[] }
    | null {
    const parts = pathname.split('/').filter(Boolean);
    const allowed = new Set<string>();

    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) {
        continue;
      }
      if (route.method === method) {
        return { route, params };
      }
      allowed.add(route.method);
    }
    return allowed.size > 0 ? { allowed: [...allowed] } : null;
  }
}

/**
 * Match path parts against a pattern.
 *
 * @returns Decoded params, or null if the path does not match.
 */
function matchSegments(
  pattern: string[],
  parts: string[],
): Record<string, string> | null {
  if (pattern.length !== parts.length) {
    return null;
  }
  // Null prototype so a param named like an Object method cannot collide.
  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i] as string;
    const actual = parts[i] as string;
    if (expected.startsWith(':')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(actual);
      } catch {
        return null;
      }
      // Reject empty, oversize and `__proto__` values: guards against
      // prototype pollution and absurdly long ids. Bad encoding is a miss.
      if (
        decoded.length === 0 ||
        decoded.length > 256 ||
        decoded === '__proto__'
      ) {
        return null;
      }
      params[expected.slice(1)] = decoded;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}
