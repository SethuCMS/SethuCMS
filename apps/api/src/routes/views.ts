import type { Capabilities } from '@sethucms/core';

export interface CapabilitySummary {
  joins: boolean;
  transactions: Capabilities['transactions'];
  filterOr: boolean;
  inequality: Capabilities['filters']['inequality'];
  fullText: boolean;
  realtime: boolean;
  writes: boolean;
}

/** The short capability list the admin shows on connection cards. */
export function capabilitySummary(
  capabilities: Capabilities,
): CapabilitySummary {
  return {
    joins: capabilities.joins,
    transactions: capabilities.transactions,
    filterOr: capabilities.filters.or,
    inequality: capabilities.filters.inequality,
    fullText: capabilities.filters.fullText,
    realtime: capabilities.realtime,
    writes: capabilities.writes,
  };
}
