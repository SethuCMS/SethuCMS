/**
 * GET /v1/schema: what the schema file says and where it disagrees with each
 * connection's database. Admins only: it can name collections that other
 * roles may not see.
 */
import { requireRole } from '../auth.js';
import type { Services } from './services.js';

export function registerSchemaRoutes(s: Services): void {
  s.router.add({
    method: 'GET',
    pattern: '/v1/schema',
    auth: 'token',
    expensive: true,
    handler: async (ctx) => {
      requireRole(ctx.principal, 'admin');
      const schema = s.schema;
      if (!schema) {
        return { status: 200, body: { data: { configured: false } } };
      }
      const checks: Array<{ connectionId: string; name: string; notes: string[]; error?: string }> = [];
      for (const connection of s.registry.list()) {
        try {
          const bound = await s.registry.bind(connection.id);
          checks.push({ connectionId: connection.id, name: connection.name, notes: bound.schemaNotes });
        } catch {
          checks.push({
            connectionId: connection.id,
            name: connection.name,
            notes: [],
            error: 'This connection could not be opened.',
          });
        }
      }
      return {
        status: 200,
        body: { data: { configured: true, source: schema.source, collections: schema.collections, checks } },
      };
    },
  });
}
