/**
 * Rules for the browser origins (CORS) a gateway accepts.
 *
 * Requests carry bearer tokens in a header, never cookies, so a browser never
 * attaches a login by itself. CORS here only decides which websites may read
 * answers from a browser. Even so, the rules are strict:
 *
 *   - An origin is a scheme, host and optional port, with no path.
 *   - By default only exact origins are accepted.
 *   - An owner can turn on one kind of wildcard (SETHUCMS_ALLOW_WILDCARD_ORIGINS)
 *     for preview deployments: `https://*.example.com`. The star stands for
 *     exactly one label, so `a.example.com` matches but `a.b.example.com` and
 *     `example.com` do not. It is https only.
 *   - Addresses on shared hosting (for example `*.vercel.app`) are refused,
 *     because anyone can publish a site there.
 */
import { errors } from '@sethucms/core';

/**
 * Hosting platforms where anyone can publish a site under the same domain.
 * A wildcard on one of these would allow every customer of the platform.
 * This is a short list of the common ones, not a complete one.
 */
const SHARED_HOSTING_SUFFIXES = [
  'vercel.app',
  'netlify.app',
  'web.app',
  'firebaseapp.com',
  'pages.dev',
  'workers.dev',
  'github.io',
  'gitlab.io',
  'herokuapp.com',
  'azurewebsites.net',
  'azurestaticapps.net',
  'cloudfront.net',
  'amplifyapp.com',
  'appspot.com',
  'run.app',
  'onrender.com',
  'fly.dev',
  'surge.sh',
  'glitch.me',
  'repl.co',
  'replit.app',
  'csb.app',
  'stackblitz.io',
  'ngrok.io',
  'ngrok-free.app',
  'trycloudflare.com',
  'loca.lt',
];

/** Second-level names used under country domains, such as co.uk or com.au. */
const COUNTRY_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** One DNS label: letters, digits and inner hyphens. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Longest origin text accepted or recorded. */
const MAX_ORIGIN_LENGTH = 200;

/** A parsed entry for the allow list. */
export interface ParsedOrigin {
  /** The normalised text to store and compare. */
  origin: string;
  /** True when it contains the one-label wildcard. */
  wildcard: boolean;
}

/**
 * Check text typed by an admin and return the normalised origin.
 *
 * @param text What the admin entered.
 * @param allowWildcard Whether the gateway owner turned wildcards on.
 * @throws A validation error that says what to change.
 */
export function parseOriginPattern(text: string, allowWildcard: boolean): ParsedOrigin {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ORIGIN_LENGTH) {
    throw errors.validation('Enter an origin such as https://example.com');
  }
  if (trimmed.includes('*')) {
    if (!allowWildcard) {
      throw errors.validation(
        'Wildcards are switched off. Enter the exact address, for example https://example.com, ' +
          'or set SETHUCMS_ALLOW_WILDCARD_ORIGINS=1 on the gateway to allow https://*.example.com.',
      );
    }
    return { origin: parseWildcard(trimmed), wildcard: true };
  }
  return { origin: parseExact(trimmed), wildcard: false };
}

/** The exact origin for the text, or throws. */
function parseExact(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw errors.validation('Enter an origin such as https://example.com');
  }
  const plain =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.pathname === '/' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password;
  if (!plain) {
    throw errors.validation(
      'Use only the scheme, host and port, for example https://example.com',
    );
  }
  return url.origin;
}

/** The normalised `https://*.base` text, or throws. */
function parseWildcard(text: string): string {
  const match = /^https:\/\/\*\.([^/:?#@*\s]+)$/i.exec(text);
  const base = match?.[1]?.toLowerCase();
  if (!base) {
    throw errors.validation(
      'A wildcard must look like https://*.example.com: https only, one star at the start of the host, no port and no path.',
    );
  }
  const labels = base.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw errors.validation(
      'A wildcard needs a full domain you own after the star, for example https://*.example.com.',
    );
  }
  // Without the full public-suffix list, refuse the common shape of one:
  // a country domain such as co.uk, or a two-letter code under com/org/net.
  const [second, top] = [labels[labels.length - 2], labels[labels.length - 1]];
  if (labels.length === 2 && top !== undefined && top.length === 2 && second && COUNTRY_SECOND_LEVEL.has(second)) {
    throw errors.validation(
      'That wildcard would cover a whole country domain. Use a domain you own, for example https://*.example.co.uk.',
    );
  }
  const shared = SHARED_HOSTING_SUFFIXES.find(
    (suffix) => base === suffix || base.endsWith(`.${suffix}`),
  );
  if (shared) {
    throw errors.validation(
      `A wildcard on ${shared} would allow every site hosted there. Put previews on a domain you own, or add each address exactly.`,
    );
  }
  return `https://*.${base}`;
}

/**
 * True when an allow-list entry covers the origin a browser sent.
 * Entries without a star must match exactly.
 */
export function matchesOrigin(entry: string, origin: string): boolean {
  if (!entry.includes('*')) {
    return entry === origin;
  }
  const prefix = 'https://*.';
  if (!entry.startsWith(prefix) || !origin.startsWith('https://')) {
    return false;
  }
  const base = entry.slice(prefix.length);
  const host = origin.slice('https://'.length);
  const suffix = `.${base}`;
  if (!host.endsWith(suffix)) {
    return false;
  }
  // What stands in for the star must be one label: no dots, ports or slashes.
  return LABEL.test(host.slice(0, host.length - suffix.length));
}

/** True when the text is exactly how a browser writes an origin. */
function isPlainOrigin(text: string): boolean {
  if (text.length === 0 || text.length > MAX_ORIGIN_LENGTH) {
    return false;
  }
  try {
    const url = new URL(text);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === text
    );
  } catch {
    return false;
  }
}

/** A site that called the gateway and was refused. */
export interface BlockedOrigin {
  origin: string;
  /** Refused requests seen since the gateway started. */
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

const MAX_BLOCKED = 20;
const MAX_USED = 500;

/**
 * Remembers, in memory only, which origins called the gateway. Admins use it
 * to see a refused site and allow it with one click, and to spot allowed
 * origins nobody uses any more.
 *
 * Anyone on the internet can send any Origin header, so this is bounded and
 * records only well-formed origins. Nothing here is saved to disk or sent to
 * the logs, and it starts empty after a restart.
 */
export class OriginWatch {
  private readonly blockedByOrigin = new Map<string, BlockedOrigin>();
  private readonly usedAt = new Map<string, string>();

  /** Note one request that carried an Origin header. */
  seen(origin: string, allowed: boolean, now: Date = new Date()): void {
    const stamp = now.toISOString();
    if (allowed) {
      this.usedAt.delete(origin); // re-insert so the oldest entry is first
      this.usedAt.set(origin, stamp);
      if (this.usedAt.size > MAX_USED) {
        const oldest = this.usedAt.keys().next().value;
        if (oldest !== undefined) {
          this.usedAt.delete(oldest);
        }
      }
      return;
    }
    if (!isPlainOrigin(origin)) {
      return;
    }
    const known = this.blockedByOrigin.get(origin);
    if (known) {
      known.count += 1;
      known.lastSeenAt = stamp;
      return;
    }
    if (this.blockedByOrigin.size >= MAX_BLOCKED) {
      // Drop the one not seen for the longest time.
      let stalest: BlockedOrigin | undefined;
      for (const item of this.blockedByOrigin.values()) {
        if (!stalest || item.lastSeenAt < stalest.lastSeenAt) {
          stalest = item;
        }
      }
      if (stalest) {
        this.blockedByOrigin.delete(stalest.origin);
      }
    }
    this.blockedByOrigin.set(origin, {
      origin,
      count: 1,
      firstSeenAt: stamp,
      lastSeenAt: stamp,
    });
  }

  /** Refused sites, most recent first. */
  blocked(): BlockedOrigin[] {
    return [...this.blockedByOrigin.values()].sort((a, b) =>
      a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0,
    );
  }

  /** When an allow-list entry was last used, or null if not since start. */
  lastUsed(entry: string): string | null {
    let latest: string | null = null;
    for (const [origin, stamp] of this.usedAt) {
      if (matchesOrigin(entry, origin) && (latest === null || stamp > latest)) {
        latest = stamp;
      }
    }
    return latest;
  }

  /** Stop listing refused sites that an entry now allows. */
  clearAllowedBy(entry: string): void {
    for (const origin of [...this.blockedByOrigin.keys()]) {
      if (matchesOrigin(entry, origin)) {
        this.blockedByOrigin.delete(origin);
      }
    }
  }
}
