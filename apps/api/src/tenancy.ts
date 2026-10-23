/**
 * Workspaces: one isolated gateway per person.
 *
 * With SETHUCMS_WORKSPACES=open, anyone who signs in with Firebase (Google or
 * GitHub, verified e-mail) gets a workspace of their own and is its admin.
 * Each workspace is a complete gateway with its own state (its own Firestore
 * collections or data folder), its own connections, tokens, people, invites,
 * files and audit log. Nothing is shared between them, so one person can never
 * reach another's content or database credentials: there is no query to forget
 * to filter.
 *
 * A request for a workspace arrives under /w/<id>/..., for example
 * /w/w3f...9a/v1/connections. The id is minted only by the sign-in route and
 * carries a signature, so an invented id is refused without any lookup and
 * nobody can make the server create workspaces by guessing addresses.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Gateway } from './gateway.js';

/** The parts of a workspace gateway this module uses. */
export type TenantGateway = Pick<Gateway, 'server' | 'services' | 'flush' | 'close'>;

const ID = /^w[0-9a-f]{40}$/;
const PATH = /^\/w\/([^/?#]+)(\/[^?#]*)?(\?.*)?$/;

interface Slot {
  gateway: Promise<TenantGateway>;
  /** Requests being answered right now; a busy workspace is never closed. */
  busy: number;
  /** Last use, for closing the least recently used idle workspace. */
  used: number;
}

export class Workspaces {
  private readonly slots = new Map<string, Slot>();

  /**
   * @param secret Signs workspace ids and derives each workspace's private
   * bootstrap token. Keep it in the environment, long and random.
   * @param create Builds the gateway for a workspace id.
   * @param max Workspaces kept open per instance; the idle ones beyond it are
   * closed and simply reopened on their next request.
   */
  constructor(
    private readonly secret: Buffer,
    private readonly create: (id: string) => Promise<TenantGateway>,
    private readonly max = 8,
  ) {}

  private mac(part: string): string {
    return createHmac('sha256', this.secret).update(`ws:${part}`).digest('hex').slice(0, 20);
  }

  /** The workspace id for a Firebase user: stable, signed, reveals nothing. */
  idFor(uid: string): string {
    const part = createHash('sha256').update(`uid:${uid}`).digest('hex').slice(0, 20);
    return `w${part}${this.mac(part)}`;
  }

  /** A new, signed project id that belongs to nobody yet. */
  mint(): string {
    const part = randomBytes(10).toString('hex');
    return `w${part}${this.mac(part)}`;
  }

  /** True only for ids this server minted. */
  valid(id: string): boolean {
    if (!ID.test(id)) {
      return false;
    }
    const wanted = Buffer.from(this.mac(id.slice(1, 21)));
    const given = Buffer.from(id.slice(21));
    return wanted.length === given.length && timingSafeEqual(wanted, given);
  }

  /**
   * Token that registers the workspace's built-in admin on its first start.
   * Derived, never shown to anyone, and different for every workspace.
   */
  bootstrapToken(id: string): string {
    return createHmac('sha256', this.secret).update(`admin:${id}`).digest('hex');
  }

  /** Open (or reuse) a workspace gateway. */
  get(id: string): Promise<TenantGateway> {
    if (!this.valid(id)) {
      return Promise.reject(new Error('Unknown workspace'));
    }
    let slot = this.slots.get(id);
    if (!slot) {
      const made: Slot = {
        gateway: Promise.resolve().then(() => this.create(id)),
        busy: 0,
        used: Date.now(),
      };
      // A failed start is not remembered.
      made.gateway.catch(() => {
        if (this.slots.get(id) === made) {
          this.slots.delete(id);
        }
      });
      this.slots.set(id, made);
      slot = made;
      this.trim();
    }
    slot.used = Date.now();
    return slot.gateway;
  }

  private trim(): void {
    if (this.slots.size <= this.max) {
      return;
    }
    const idle = [...this.slots.entries()]
      .filter(([, slot]) => slot.busy === 0)
      .sort((a, b) => a[1].used - b[1].used);
    for (const [id, slot] of idle) {
      if (this.slots.size <= this.max) {
        break;
      }
      this.slots.delete(id);
      void slot.gateway.then((gateway) => gateway.close()).catch(() => undefined);
    }
  }

  /**
   * Answer a /w/<id>/... request. Returns false for any other path, which the
   * main gateway then handles as usual.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const match = PATH.exec(req.url ?? '');
    if (!match) {
      return false;
    }
    const id = match[1] as string;
    if (!this.valid(id)) {
      this.refuse(res, 404, 'NOT_FOUND', 'Unknown workspace.');
      return true;
    }
    let gateway: TenantGateway;
    try {
      gateway = await this.get(id);
    } catch (error) {
      console.error(
        `SethuCMS workspace could not start: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      this.refuse(res, 503, 'UNAVAILABLE', 'This workspace could not start.');
      return true;
    }
    const slot = this.slots.get(id);
    if (slot) {
      slot.busy += 1;
    }
    // The workspace gateway sees an ordinary request for its own root.
    req.url = `${match[2] ?? '/'}${match[3] ?? ''}`;
    await new Promise<void>((resolve) => {
      res.once('close', resolve);
      gateway.server.emit('request', req, res);
    });
    if (slot) {
      slot.busy -= 1;
    }
    // A function may freeze right after the response: save pending audit.
    await gateway.flush().catch(() => undefined);
    return true;
  }

  private refuse(res: ServerResponse, status: number, code: string, message: string): void {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: { code, message } }));
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.slots.values()].map((slot) =>
        slot.gateway.then((gateway) => gateway.flush()).catch(() => undefined),
      ),
    );
  }

  async close(): Promise<void> {
    const all = [...this.slots.values()];
    this.slots.clear();
    await Promise.all(
      all.map((slot) =>
        slot.gateway.then((gateway) => gateway.close()).catch(() => undefined),
      ),
    );
  }
}
