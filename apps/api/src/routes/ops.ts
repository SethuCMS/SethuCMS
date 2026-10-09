/**
 * Operations: the metrics endpoint for monitoring tools.
 *
 * GET /v1/metrics answers in the Prometheus text format. It needs an admin
 * token, or the separate SETHUCMS_METRICS_TOKEN when one is set, so a scraper
 * does not have to hold an admin credential. Labels never contain ids or paths.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { errors } from '@sethucms/core';
import { API_SECURITY_HEADERS } from '../http/respond.js';
import type { Services } from './services.js';

const sha256 = (value: string): Buffer =>
  createHash('sha256').update(value).digest();

export function registerOpsRoutes(s: Services): void {
  s.router.add({
    method: 'GET',
    pattern: '/v1/metrics',
    auth: 'none',
    handler: (ctx) => {
      const header = ctx.req.headers['authorization'];
      const bearer =
        typeof header === 'string'
          ? /^Bearer (\S{16,200})$/.exec(header)?.[1]
          : undefined;
      const scraper =
        s.metricsToken !== undefined &&
        bearer !== undefined &&
        timingSafeEqual(sha256(bearer), sha256(s.metricsToken));
      if (!scraper) {
        const principal = s.auth.authenticate(header);
        if (principal.role !== 'admin') {
          throw errors.forbidden('Only administrators can read metrics');
        }
      }
      const body = s.metrics.text();
      ctx.res.writeHead(200, {
        ...API_SECURITY_HEADERS,
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      ctx.res.end(body);
      return 'handled';
    },
  });
}
