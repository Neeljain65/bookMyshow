import { pool, withTx } from '../db/pool.js';

export async function enqueueJob(task, payload = {}, { runAt = new Date(), maxAttempts = 5, client = null } = {}) {
  const db = client ?? pool;
  const { rows } = await db.query(
    `INSERT INTO jobs (task, payload, status, run_at, max_attempts)
     VALUES ($1, $2::jsonb, 'pending', $3, $4)
     RETURNING id, task, run_at`,
    [task, JSON.stringify(payload), runAt, maxAttempts],
  );
  return rows[0];
}

/** Claim one due job with FOR UPDATE SKIP LOCKED. */
export async function claimNextJob() {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `
      SELECT id, task, payload, attempts, max_attempts
      FROM jobs
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY run_at, id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
    );
    if (!rows.length) return null;

    const job = rows[0];
    await client.query(
      `UPDATE jobs
       SET status = 'running', attempts = attempts + 1, updated_at = now()
       WHERE id = $1`,
      [job.id],
    );
    return { ...job, attempts: job.attempts + 1 };
  });
}

export async function completeJob(jobId) {
  await pool.query(
    `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

/**
 * Retry with exponential backoff, or dead-letter after max attempts.
 * delay = min(60s, 2^attempts) seconds.
 */
export async function failJob(jobId, error, { attempts, maxAttempts }) {
  const message = error?.message ?? String(error);
  if (attempts >= maxAttempts) {
    await pool.query(
      `UPDATE jobs
       SET status = 'dead', last_error = $2, updated_at = now()
       WHERE id = $1`,
      [jobId, message],
    );
    return { outcome: 'dead' };
  }

  const delaySec = Math.min(60, 2 ** attempts);
  await pool.query(
    `UPDATE jobs
     SET status = 'pending',
         run_at = now() + make_interval(secs => $2),
         last_error = $3,
         updated_at = now()
     WHERE id = $1`,
    [jobId, delaySec, message],
  );
  return { outcome: 'retry', delaySec };
}

export async function getJob(jobId) {
  const { rows } = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  return rows[0] ?? null;
}
