/**
 * Serves the built admin app from the same address as the API, so one process
 * is all you need to run the CMS. Unknown paths fall back to index.html so
 * client-side routes keep working.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

// Content types by extension; anything else is sent as opaque bytes.
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

/** The admin loads only its own files and talks only to this gateway. */
const PAGE_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

/**
 * Serve a file of the built admin app.
 *
 * @param root Folder with the built admin app.
 * @param pathname Request path.
 * @param res Response to write to.
 * @returns false if nothing was served, so the caller can answer 404.
 */
export async function serveAdmin(
  root: string,
  pathname: string,
  res: ServerResponse,
): Promise<boolean> {
  const base = resolve(root);
  // Resolve, then check the result is still inside `root` (no `../` escape).
  const wanted = resolve(join(base, normalize(decodeSafe(pathname))));
  if (wanted !== base && !wanted.startsWith(base + sep)) {
    return false;
  } // path traversal attempt

  let file = wanted;
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, 'index.html');
    }
    await stat(file);
  } catch {
    if (extname(pathname)) {
      return false;
    } // a missing asset is a real 404
    file = join(base, 'index.html'); // client-side route
    try {
      await stat(file);
    } catch {
      return false;
    }
  }

  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  // Hashed file names never change, so they can be cached forever;
  // index.html must be revalidated to pick up new releases.
  const isAsset = file.includes(`${sep}assets${sep}`); // Vite fingerprints these file names
  res.writeHead(200, {
    ...PAGE_HEADERS,
    'Content-Type': type,
    'Cache-Control': isAsset
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
  });
  createReadStream(file).pipe(res);
  return true;
}

// Strip NUL bytes (a classic path trick); bad encoding falls back to root.
function decodeSafe(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/\0/g, '');
  } catch {
    return '/';
  }
}
