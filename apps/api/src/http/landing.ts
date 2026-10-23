/**
 * A small friendly page for people who open the gateway address in a browser.
 * The gateway speaks JSON to programs; a person who pastes its address into a
 * browser would otherwise see a bare error. Programs (anything that does not
 * ask for HTML) keep getting the JSON answers.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Where people go to use SethuCMS. Fixed text, never built from a request. */
const ADMIN_URL = 'https://sethucms-admin.vercel.app';
const CODE_URL = 'https://github.com/SethuCMS';

/**
 * True when a browser is asking for a page: a GET or HEAD that accepts HTML.
 * Programs and scripts normally ask for JSON, or for anything at all.
 */
export function wantsHtml(req: IncomingMessage): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }
  const accept = req.headers['accept'];
  return typeof accept === 'string' && accept.includes('text/html');
}

/** What the page says for each situation. Plain words, no request data. */
const NOTES: Record<200 | 404 | 405, string> = {
  200: 'The gateway is running. This address is for apps, not for people.',
  404: 'There is nothing at this address. This is the SethuCMS gateway.',
  405: 'This address is part of the API, so a browser cannot open it. Use the admin app instead.',
};

/** Build the page text. Only fixed strings go in, so nothing needs escaping. */
function page(note: string): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex"><title>SethuCMS gateway</title>',
    '<style>',
    'body{margin:0;min-height:100vh;display:grid;place-items:center;',
    'font:16px/1.6 system-ui,sans-serif;background:#faf8f5;color:#1f2933}',
    '@media(prefers-color-scheme:dark){body{background:#14171a;color:#e6e8ea}}',
    'main{max-width:30rem;padding:2rem}h1{font-size:1.5rem;margin:0 0 .5rem}',
    'a{color:inherit;font-weight:600}p{margin:.5rem 0}',
    '</style></head><body><main>',
    '<h1>SethuCMS gateway</h1>',
    `<p>${note}</p>`,
    `<p><a href="${ADMIN_URL}">Open the admin app</a></p>`,
    `<p><a href="${CODE_URL}">Read about SethuCMS</a></p>`,
    '</main></body></html>',
  ].join('');
}

/**
 * Send the page. The status stays honest (200, 404 or 405) so tools and
 * caches still see what happened; only the body is friendlier.
 */
export function sendLanding(
  res: ServerResponse,
  status: 200 | 404 | 405,
  extraHeaders: Record<string, string> = {},
): void {
  const body = page(NOTES[status]);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

/**
 * Show the page when a browser asked for one. Returns true when it did, so the
 * caller can stop; false means a program is calling and should get JSON.
 */
export function showLanding(
  req: IncomingMessage,
  res: ServerResponse,
  status: 200 | 404 | 405,
  extraHeaders: Record<string, string> = {},
): boolean {
  if (!wantsHtml(req)) {
    return false;
  }
  sendLanding(res, status, extraHeaders);
  return true;
}
