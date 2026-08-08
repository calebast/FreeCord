export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}
export interface RateLimiter {
  consume(key: string, now?: number): RateLimitResult;
}

export interface InMemoryRateLimiterOptions {
  windowMs: number;
  max: number;
  maxKeys: number;
}

interface Bucket {
  count: number;
  windowStartedAt: number;
  touchedAt: number;
}

/** A bounded fixed-window limiter intended for one API process. */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: InMemoryRateLimiterOptions) {
    if (!Number.isInteger(options.windowMs) || options.windowMs <= 0) throw new Error("invalid_rate_limit_window");
    if (!Number.isInteger(options.max) || options.max <= 0) throw new Error("invalid_rate_limit_max");
    if (!Number.isInteger(options.maxKeys) || options.maxKeys <= 0) throw new Error("invalid_rate_limit_max_keys");
  }

  consume(key: string, now = Date.now()): RateLimitResult {
    const existing = this.buckets.get(key);
    const bucket = existing && now - existing.windowStartedAt < this.options.windowMs
      ? existing
      : { count: 0, windowStartedAt: now, touchedAt: now };
    bucket.touchedAt = now;
    bucket.count += 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.evict(now);

    if (bucket.count <= this.options.max) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStartedAt + this.options.windowMs - now) / 1000)),
    };
  }

  get size(): number { return this.buckets.size; }

  private evict(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStartedAt >= this.options.windowMs) this.buckets.delete(key);
    }
    while (this.buckets.size > this.options.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.buckets.delete(oldest);
    }
  }
}
