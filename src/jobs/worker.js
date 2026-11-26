import { config } from '../config.js';
import { claimNextJob, completeJob, failJob } from './queue.js';
import { handlers } from './handlers.js';

export function startJobWorker({
  intervalMs = config.jobWorkerIntervalMs,
  keepAlive = false,
} = {}) {
  let busy = false;

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      // Drain a few jobs per tick so the queue doesn't stall behind the interval.
      for (let i = 0; i < config.jobWorkerBatchSize; i++) {
        const job = await claimNextJob();
        if (!job) break;

        const handler = handlers[job.task];
        if (!handler) {
          await failJob(job.id, new Error(`unknown task ${job.task}`), {
            attempts: job.max_attempts,
            maxAttempts: job.max_attempts,
          });
          console.error(`[jobs] dead unknown task id=${job.id} task=${job.task}`);
          continue;
        }

        try {
          const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
          await handler(payload);
          await completeJob(job.id);
          console.log(`[jobs] done id=${job.id} task=${job.task} attempt=${job.attempts}`);
        } catch (err) {
          const result = await failJob(job.id, err, {
            attempts: job.attempts,
            maxAttempts: job.max_attempts,
          });
          console.warn(
            `[jobs] ${result.outcome} id=${job.id} task=${job.task} attempt=${job.attempts}: ${err.message}` +
              (result.delaySec ? ` retryIn=${result.delaySec}s` : ''),
          );
        }
      }
    } catch (err) {
      console.error('[jobs] worker tick failed:', err.message);
    } finally {
      busy = false;
    }
  };

  const handle = setInterval(tick, intervalMs);
  if (!keepAlive) handle.unref?.();
  console.log(`[jobs] worker every ${intervalMs}ms batch=${config.jobWorkerBatchSize}`);
  // Run once immediately so notify jobs don't wait a full interval.
  tick();
  return () => clearInterval(handle);
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('worker.js');
if (isMain) {
  startJobWorker({ keepAlive: true });
}
