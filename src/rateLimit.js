/**
 * In-memory token bucket rate limiter.
 *
 * Strategy: token bucket (not fixed window / sliding window).
 * - Bucket holds at most `capacity` tokens (burst size).
 * - Tokens refill at `refillPerSecond` continuously (computed lazily on each request).
 * - Each allowed request consumes 1 token; if empty → reject (429).
 *
 * Why this vs fixed window: fixed windows allow 2× burst at the boundary.
 * Why in-memory for v1: single API process. Multi-instance later → same algorithm in Redis + Lua.
 */

export class RateLimitError extends Error {
  constructor(message, { retryAfterMs, key } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
    this.key = key;
  }
}

class TokenBucket {
  constructor({ capacity, refillPerSecond }) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.updatedAt = performance.now();
  }

  /** @returns {{ ok: true } | { ok: false, retryAfterMs: number }} */
  take() {
    const now = performance.now();
    const elapsedSec = (now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.updatedAt = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { ok: true };
    }

    const need = 1 - this.tokens;
    const retryAfterMs = Math.ceil((need / this.refillPerSecond) * 1000);
    return { ok: false, retryAfterMs };
  }
}

export function createRateLimiter({ capacity, refillPerSecond, idleTtlMs = 10 * 60 * 1000 }) {
  /** @type {Map<string, TokenBucket>} */
  const buckets = new Map();

  function getBucket(key) {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket({ capacity, refillPerSecond });
      buckets.set(key, bucket);
    }
    return bucket;
  }

  // Drop idle keys so the Map does not grow forever.
  setInterval(() => {
    const now = performance.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt > idleTtlMs) buckets.delete(key);
    }
  }, Math.min(idleTtlMs, 60_000)).unref?.();

  return {
    /**
     * Consume one token for `key`, or throw RateLimitError.
     * Synchronous on purpose so check+consume cannot interleave on one Node process.
     */
    check(key) {
      const result = getBucket(key).take();
      if (!result.ok) {
        throw new RateLimitError('rate limit exceeded', {
          key,
          retryAfterMs: result.retryAfterMs,
        });
      }
    },
    /** Test helper */
    _reset() {
      buckets.clear();
    },
  };
}
