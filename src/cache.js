import { getRedis, redisReady } from './redis.js';
import { config } from './config.js';

const memory = new Map(); // key -> { value, expiresAt }
const inflight = new Map(); // singleflight per process

function memGet(key) {
  const row = memory.get(key);
  if (!row) return null;
  if (row.expiresAt && Date.now() > row.expiresAt) {
    memory.delete(key);
    return null;
  }
  return row.value;
}

function memSet(key, value, ttlSec) {
  const jitter = Math.floor(Math.random() * (config.cache.ttlJitterSec + 1));
  memory.set(key, {
    value,
    expiresAt: Date.now() + (ttlSec + jitter) * 1000,
  });
}

async function redisGet(key) {
  if (!redisReady()) return null;
  const raw = await getRedis().get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function redisSet(key, value, ttlSec) {
  if (!redisReady()) return;
  const jitter = Math.floor(Math.random() * (config.cache.ttlJitterSec + 1));
  await getRedis().set(key, JSON.stringify(value), 'EX', ttlSec + jitter);
}

async function withStampedeLock(key, loader) {
  const lockKey = `lock:${key}`;
  const redis = getRedis();

  if (redisReady()) {
    const got = await redis.set(lockKey, '1', 'EX', 10, 'NX');
    if (got === 'OK') {
      try {
        return await loader();
      } finally {
        await redis.del(lockKey).catch(() => {});
      }
    }
    // Someone else is loading; short wait then re-check cache.
    await new Promise((r) => setTimeout(r, 50));
    const again = await redisGet(key);
    if (again != null) return again;
    return loader();
  }

  // In-process singleflight when Redis is down.
  if (inflight.has(key)) return inflight.get(key);
  const p = loader().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/**
 * Cache-aside: get from Redis (or memory), else load, set, return.
 * Stampede: only one loader fills a hot miss (Redis NX lock / local singleflight).
 */
export async function cacheAside(key, ttlSec, loader) {
  const cached = (await redisGet(key)) ?? memGet(key);
  if (cached != null) return { data: cached, source: redisReady() ? 'redis' : 'memory' };

  const data = await withStampedeLock(key, loader);
  await redisSet(key, data, ttlSec);
  memSet(key, data, ttlSec);
  return { data, source: 'db' };
}

export async function cacheInvalidate(key) {
  memory.delete(key);
  if (redisReady()) await getRedis().del(key).catch(() => {});
}

export async function cacheInvalidatePrefix(prefix) {
  for (const key of memory.keys()) {
    if (key.startsWith(prefix)) memory.delete(key);
  }
  if (!redisReady()) return;
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}
