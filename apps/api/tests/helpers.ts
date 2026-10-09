// Shared harness for the API tests - boots a real gateway on an ephemeral port
// and offers HTTP, token and SSE helpers.

import { createGateway, type Gateway } from '../src/gateway.js';
import { silentLogger } from '../src/logger.js';
import type { GatewayConfig } from '../src/config.js';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0123456789';

export interface TestGateway {
  gateway: Gateway;
  url: string;
  close(): Promise<void>;
  call(
    method: string,
    path: string,
    options?: CallOptions,
  ): Promise<{ status: number; body: any; headers: Headers }>;
}

export interface CallOptions {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
}

// Port 0 avoids clashes between parallel test files; private networks are
// allowed so tests can reach localhost backends.
export async function startGateway(
  overrides: Partial<GatewayConfig> = {},
  extra: Partial<Parameters<typeof createGateway>[0]> = {},
): Promise<TestGateway> {
  const config: GatewayConfig = {
    dataDir: undefined,
    production: false,
    allowedOrigins: ['http://admin.test'],
    allowPrivateNetworks: true,
    trustProxy: false,
    adminDir: undefined,
    seedDemo: true,
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  };
  const gateway = await createGateway({
    config,
    env: { SETHUCMS_ADMIN_TOKEN: ADMIN_TOKEN },
    logger: silentLogger,
    ...extra,
  });
  const { port } = await gateway.listen();
  const url = `http://127.0.0.1:${port}`;

  // A real fetch against a real listener is used so middleware, headers and
  // body parsing are exercised, not mocked.
  return {
    gateway,
    url,
    close: () => gateway.close(),
    async call(method, path, options = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      // token null means "send no credential", which is how auth-required paths
      // are tested; undefined defaults to admin.
      const token = options.token === undefined ? ADMIN_TOKEN : options.token;
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const response = await fetch(url + path, {
        method,
        headers,
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: text ? JSON.parse(text) : undefined,
        headers: response.headers,
      };
    },
  };
}

/** Find the demo connection id. */
export async function demoConnection(t: TestGateway): Promise<string> {
  const list = await t.call('GET', '/v1/connections');
  return list.body.data[0].id as string;
}

/** Create a token with a role and return its value. */
export async function tokenFor(
  t: TestGateway,
  role: 'editor' | 'viewer' | 'admin',
): Promise<string> {
  const created = await t.call('POST', '/v1/admin/tokens', {
    body: { name: `${role} test`, role },
  });
  return created.body.data.token as string;
}

// SSE reader - the stream never ends by itself, so it stops after count events
// or a 5s timeout instead of hanging the suite.
/** Read server-sent events until `count` events arrive (or time runs out). */
export async function readEvents(
  url: string,
  headers: Record<string, string>,
  count: number,
  trigger?: () => Promise<void>,
): Promise<Array<{ event: string; data: any }>> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (response.status !== 200) {
    throw new Error(`stream answered ${response.status}`);
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const seen: Array<{ event: string; data: any }> = [];
  let buffer = '';
  const timer = setTimeout(() => controller.abort(), 5000);
  let triggered = false;
  try {
    while (seen.length < count) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const event = /^event: (.*)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (event && data) {
          seen.push({ event, data: JSON.parse(data) });
        }
      }
      // The trigger runs only after the stream is open, so the event it causes
      // cannot be missed.
      if (!triggered && trigger) {
        triggered = true;
        await trigger();
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return seen;
}
