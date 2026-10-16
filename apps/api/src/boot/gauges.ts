/**
 * Metrics that are read on demand rather than counted as they happen.
 */
import { AuditLog } from '../audit.js';
import { ConnectionRegistry } from '../connections/registry.js';
import { EventBus } from '../events.js';
import { Metrics } from '../metrics.js';
import { type Services } from '../routes/services.js';
import { type StateStore } from '../store/state.js';

/** Register the values a monitoring tool reads when it scrapes /metrics. */
export function registerGauges(input: {
  metrics: Metrics;
  events: EventBus;
  services: Services;
  registry: ConnectionRegistry;
  store: StateStore;
  audit: AuditLog;
}): void {
  const { metrics, events, services, registry, store, audit } = input;
  events.subscribe((event) => metrics.events.inc({ type: event.type }));
  metrics.gauge(
    'sethucms_event_streams_open',
    'Open live event streams.',
    () => services.streams.open,
  );
  metrics.gauge(
    'sethucms_connections',
    'Saved database connections, by adapter type.',
    () => {
      const byAdapter = new Map<string, number>();
      for (const connection of registry.list()) {
        byAdapter.set(
          connection.adapterType,
          (byAdapter.get(connection.adapterType) ?? 0) + 1,
        );
      }
      return [...byAdapter].map(([adapter, value]) => ({
        labels: { adapter },
        value,
      }));
    },
  );
  metrics.gauge(
    'sethucms_api_tokens_active',
    'API tokens that are not revoked.',
    () =>
      Object.values(store.read().tokens).filter((token) => !token.revokedAt)
        .length,
  );
  metrics.gauge(
    'sethucms_audit_entries_total',
    'Audit entries written since the gateway started.',
    () => audit.written,
    'counter',
  );
}
