/**
 * Live change events.
 *
 * Events describe changes that went THROUGH the gateway (a record saved in the
 * admin, a draft edited, a draft published). Changes made directly in the
 * database by other tools are not seen. They carry ids only, never field
 * values, so a subscriber learns what changed and then fetches it with its
 * own permissions.
 */
/** A change notification. Ids and versions only, never field values. */
export type CmsEvent =
  | {
      type: 'record.created' | 'record.updated' | 'record.deleted';
      connectionId: string;
      collection: string;
      recordId: string;
    }
  | {
      type:
        | 'draft.created'
        | 'draft.updated'
        | 'draft.discarded'
        | 'draft.published';
      connectionId: string;
      collection: string;
      draftId: string;
      recordId: string | null;
      version: number;
    }
  | { type: 'connection.changed'; connectionId: string };

/** Callback that receives events. */
export type Listener = (event: CmsEvent) => void;

/**
 * In-process publish/subscribe for {@link CmsEvent}s, optionally relayed to
 * other gateways when state is shared.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  // Local listeners see only events born here; they do the once-per-event
  // work (e.g. writing the change feed) that other gateways do for theirs.
  private readonly localListeners = new Set<Listener>();
  private relay: ((event: CmsEvent) => void) | undefined;

  /** Pass events made here on to other gateways (shared state). */
  setRelay(relay: ((event: CmsEvent) => void) | undefined): void {
    this.relay = relay;
  }

  /**
   * An event that came from another gateway: tell local listeners, but do not
   * send it on again.
   */
  publishRemote(event: CmsEvent): void {
    this.deliver(event);
  }

  /**
   * Like subscribe, but only for events made by THIS gateway (not those relayed
   * from others). For things that must happen once per event, such as writing
   * the change feed.
   */
  subscribeLocal(listener: Listener): () => void {
    this.localListeners.add(listener);
    return () => this.localListeners.delete(listener);
  }

  /** Receive every event, local or relayed. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Announce an event from this gateway: local listeners, then the relay. */
  publish(event: CmsEvent): void {
    this.deliver(event);
    for (const listener of [...this.localListeners]) {
      try {
        listener(event);
      } catch {
        // see deliver()
      }
    }
    try {
      this.relay?.(event);
    } catch {
      // Relaying is best effort: local listeners already have the event.
    }
  }

  /** Call every subscriber; one failing must not block the others. */
  private deliver(event: CmsEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // One broken subscriber must not stop the others.
      }
    }
  }

  /** Number of current subscribers (for metrics). */
  get subscriberCount(): number {
    return this.listeners.size;
  }
}
