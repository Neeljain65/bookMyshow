import Redis from 'ioredis';
import { config } from './config.js';

/** @type {import('ioredis').default | null} */
let client = null;
let ready = false;

export function getRedis() {
  return client;
}

export async function connectRedis() {
  if (!config.redis.enabled) {
    console.log('[redis] disabled');
    return false;
  }

  client = new Redis(config.redis.url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 2000,
    retryStrategy(times) {
      // Fail fast on startup; don't keep reconnect-spamming the logs.
      if (times > 2) return null;
      return 200;
    },
  });

  client.on('error', (err) => {
    ready = false;
    if (config.redis.verbose) console.error('[redis]', err.message);
  });
  client.on('ready', () => {
    ready = true;
  });
  client.on('end', () => {
    ready = false;
  });

  try {
    const pong = await client.ping();
    ready = pong === 'PONG';
    if (ready) {
      console.log(`[redis] connected ${config.redis.url}`);
      return true;
    }
  } catch (err) {
    ready = false;
    console.warn(`[redis] unavailable (${err.message}); using in-memory fallback`);
    try {
      client.disconnect();
    } catch {
      /* ignore */
    }
    client = null;
    return false;
  }
  return false;
}

export function redisReady() {
  return ready && client != null;
}
