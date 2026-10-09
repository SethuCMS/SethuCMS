// Token-bucket rate limiter used to throttle requests per key.
/**
 * A small in-memory token bucket. Good for one gateway process; use a shared
 * store when scaling out.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns 0 when allowed, otherwise the seconds to wait. */
  take(key: string): number {
    const time = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: time };
    // Refill for the time elapsed, capped so idle keys cannot bank unlimited
    // bursts.
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((time - bucket.at) / 1000) * this.refillPerSecond,
    );
    bucket.at = time;

    let wait = 0;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
    } else {
      // Tell the client how long until one token is available (at least 1 s).
      wait = Math.max(1, Math.ceil((1 - bucket.tokens) / this.refillPerSecond));
    }

    this.buckets.set(key, bucket);
    // Bound memory: forget keys idle for a minute (they would be full anyway).
    if (this.buckets.size > 10_000) {
      this.evictIdle(time);
    }
    return wait;
  }

  /** Drop buckets not touched for 60 s. */
  private evictIdle(time: number): void {
    for (const [key, bucket] of this.buckets) {
      if (time - bucket.at > 60_000) {
        this.buckets.delete(key);
      }
    }
  }
}
