/**
 * Entry point for hosts that run the gateway as short-lived functions, such as
 * Vercel. The same gateway code answers each request; its state lives in
 * Firestore (see SharedFirestoreStateStore) so any number of instances can run
 * side by side.
 *
 * Needed in the environment: SETHUCMS_FIRESTORE_PROJECT, the Firestore
 * credentials (SETHUCMS_FIRESTORE_CREDENTIALS_JSON on hosts outside Google),
 * and the usual four secrets (SETHUCMS_VAULT_KEY, SETHUCMS_CURSOR_SECRET,
 * SETHUCMS_PREVIEW_SECRET, SETHUCMS_ADMIN_TOKEN). NODE_ENV=production.
 *
 * Not available in this mode: live events, the change feed and webhooks
 * (they need a process that stays up; the gateway answers 501), and long
 * migrations (a function ends after its time limit).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configFromEnv } from './config.js';
import { createGateway, type Gateway } from './gateway.js';

export type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void>;

/**
 * Wrap a gateway factory as a request handler. The gateway is built on the
 * first request of an instance and reused; a failed start is retried on the
 * next request instead of being remembered.
 */
export function createHandler(make: () => Promise<Gateway>): RequestHandler {
  let ready: Promise<Gateway> | undefined;
  return async (req, res) => {
    // `then` also catches a factory that throws before returning a promise.
    ready ??= Promise.resolve().then(make).catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    let gateway: Gateway;
    try {
      gateway = await ready;
    } catch (error) {
      // Messages from config and the Firestore layer never contain secrets.
      console.error(
        `SethuCMS could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          error: {
            code: 'UNAVAILABLE',
            message: 'The gateway could not start. See the function logs.',
          },
        }),
      );
      return;
    }
    await new Promise<void>((resolve) => {
      res.once('close', resolve);
      gateway.server.emit('request', req, res);
    });
    // The instance may freeze right after this: save pending audit entries.
    await gateway.flush().catch(() => undefined);
  };
}

const handler: RequestHandler = createHandler(() =>
  createGateway({
    config: configFromEnv({
      SETHUCMS_DATA_DIR: 'memory',
      ...process.env,
      SETHUCMS_SERVERLESS: '1',
    }),
  }),
);

export default handler;
