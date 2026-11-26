import { getRedis, redisReady } from './redis.js';
import { createRateLimiter, RateLimitError } from './rateLimit.js';

/**
 * Atomic token bucket in Redis (Lua).
 * Hash fields: tokens, ts (ms). Falls back to in-memory if Redis is down.
 */
const LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000.0
tokens = math.min(capacity, tokens + elapsed * refill)
ts = now

if tokens >= cost then
  tokens = tokens - cost
  redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', key, 600000)
  return {1, 0, tokens}
end

local need = cost - tokens
local retryMs = math.ceil((need / refill) * 1000)
redis.call('HMSET', key, 'tokens', tokens, 'ts', ts)
redis.call('PEXPIRE', key, 600000)
return {0, retryMs, tokens}
`;

export function createRedisRateLimiter({ capacity, refillPerSecond }) {
  const memoryFallback = createRateLimiter({ capacity, refillPerSecond });

  return {
    async check(key) {
      if (!redisReady()) {
        memoryFallback.check(key);
        return;
      }

      const redis = getRedis();
      const fullKey = `rl:${key}`;
      const result = await redis.eval(
        LUA,
        1,
        fullKey,
        String(capacity),
        String(refillPerSecond),
        String(Date.now()),
        '1',
      );

      const allowed = Number(result[0]) === 1;
      if (!allowed) {
        throw new RateLimitError('rate limit exceeded', {
          key,
          retryAfterMs: Number(result[1]) || 1000,
        });
      }
    },
  };
}

export { RateLimitError };
