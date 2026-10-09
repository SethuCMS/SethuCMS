/**
 * Keeps the gateway from being used to reach things it should not.
 *
 * Anyone who can add a connection can make the gateway open a network
 * connection to a host of their choosing. Without a check, that host could be
 * the cloud metadata service (which hands out credentials) or an internal
 * system. Before connecting we resolve the host name and refuse private,
 * loopback and link-local addresses, unless the operator allowed them.
 *
 * The cloud metadata addresses stay blocked even when private networks are
 * allowed.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { errors } from '@sethucms/core';

/** Settings for {@link NetworkGuard}. */
export interface NetworkGuardOptions {
  /**
   * Allow private/loopback addresses (development, or databases inside your own
   * network).
   */
  allowPrivateNetworks: boolean;
  /** Replace DNS, for tests. */
  resolve?: (host: string) => Promise<string[]>;
}

/** Split a dotted-quad into octets; null if not valid IPv4. */
function parseIPv4(address: string): number[] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : null;
}

/** Addresses nobody should reach through the gateway, ever. */
function isAlwaysBlocked(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) {
    // Compare octets, not strings: "169.254.x.x" must not be spoofable.
    return v4[0] === 169 && v4[1] === 254;
  } // link-local, includes 169.254.169.254 metadata
  const lower = address.toLowerCase();
  return lower.startsWith('fe80:') || lower === 'fd00:ec2::254';
}

/** True for RFC1918, loopback, CGNAT and IPv6 local ranges. */
function isPrivate(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const lower = address.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged as the IPv4 inside,
  // otherwise it would slip past the private-range check.
  if (lower.startsWith('::ffff:')) {
    return isPrivate(lower.slice(7)) || isAlwaysBlocked(lower.slice(7));
  }
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80')
  );
}

/**
 * Vets database host names before the gateway connects to them (SSRF
 * defence). Create one per process with the operator policy.
 */
export class NetworkGuard {
  private readonly resolve: (host: string) => Promise<string[]>;

  constructor(private readonly options: NetworkGuardOptions) {
    this.resolve =
      options.resolve ??
      (async (host) =>
        (await lookup(host, { all: true })).map((entry) => entry.address));
  }

  /** Throws a VALIDATION_FAILED error when the host is not allowed. */
  async assertAllowed(host: string): Promise<void> {
    await this.vet(host);
  }

  /**
   * Check the host and return the address to connect to. Connect to THIS
   * address, not to the name again, so the name cannot point somewhere else a
   * moment later (DNS rebinding).
   */
  async vet(host: string): Promise<string> {
    let addresses: string[];
    if (isIP(host)) {
      addresses = [host];
    } else {
      try {
        addresses = await this.resolve(host);
      } catch {
        throw errors.validation('The database host name could not be resolved');
      }
    }
    if (addresses.length === 0) {
      throw errors.validation('The database host name could not be resolved');
    }

    // Check every resolved address, not just the first: a name with one
    // public and one internal record must still be refused.
    for (const address of addresses) {
      if (isAlwaysBlocked(address)) {
        throw errors.validation('That network address is not allowed');
      }
      if (!this.options.allowPrivateNetworks && isPrivate(address)) {
        throw errors.validation(
          'Private network addresses are not allowed. Ask the operator to set SETHUCMS_ALLOW_PRIVATE_NETWORKS.',
        );
      }
    }
    return addresses[0] as string;
  }
}
