/**
 * Server-sent events: a long-lived response the server writes to whenever
 * something happens.
 */
import type { ServerResponse } from 'node:http';
import { API_SECURITY_HEADERS } from './respond.js';

/** Handle for pushing events to one connected client. */
export interface EventStream {
  send(event: string, data: unknown): void;
  /** Called once when the client goes away. */
  onClose(callback: () => void): void;
  close(): void;
}

// Comment frames every 25s keep proxies from closing an idle connection.
const HEARTBEAT_MS = 25_000;

/**
 * Start an SSE response and return a handle to write to it.
 *
 * @param res Response to take over; headers are sent immediately.
 * @param extraHeaders Added to the security headers (e.g. CORS).
 * @returns A stream. `send` is a no-op after the client disconnects.
 */
export function openEventStream(
  res: ServerResponse,
  extraHeaders: Record<string, string> = {},
): EventStream {
  res.writeHead(200, {
    ...API_SECURITY_HEADERS,
    ...extraHeaders,
    'Content-Type': 'text/event-stream; charset=utf-8',
    // `no-transform` and X-Accel-Buffering stop proxies buffering the stream.
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const callbacks: Array<() => void> = [];
  let closed = false;
  // Idempotent cleanup: runs once whether the client or the server closes.
  const finish = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    for (const callback of callbacks) {
      callback();
    }
  };

  const heartbeat = setInterval(
    () => res.write(': keep-alive\n\n'),
    HEARTBEAT_MS,
  );
  heartbeat.unref();
  res.on('close', finish);

  return {
    send(event, data) {
      if (closed) {
        return;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    onClose(callback) {
      callbacks.push(callback);
    },
    close() {
      finish();
      res.end();
    },
  };
}
