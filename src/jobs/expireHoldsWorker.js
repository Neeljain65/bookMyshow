import { config } from '../config.js';
import { expireExpiredHolds } from '../inventory.js';
import { pool } from '../db/pool.js';

/**
 * Periodically frees seats whose hold TTL has passed.
 * Safe to run alongside opportunistic reclaim on read/hold.
 */
export function startExpireHoldsWorker({
  intervalMs = config.expireHoldsIntervalMs,
  keepAlive = false,
} = {}) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await expireExpiredHolds(pool);
      if (result.seatsFreed > 0 || result.holdsExpired > 0) {
        console.log(
          `[expire-holds] seatsFreed=${result.seatsFreed} holdsExpired=${result.holdsExpired}`,
        );
      }
    } catch (err) {
      console.error('[expire-holds] failed:', err.message);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, intervalMs);
  // When embedded in the API server, don't keep the event loop forever on its own.
  if (!keepAlive) handle.unref?.();
  console.log(`[expire-holds] worker every ${intervalMs}ms`);
  return () => clearInterval(handle);
}

const isMain =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('expireHoldsWorker.js');
if (isMain) {
  startExpireHoldsWorker({ keepAlive: true });
}
