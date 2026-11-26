/**
 * Concurrent hold stress test (like race_condition bench).
 *
 * Default: 100 users all try to hold the SAME seat → expect exactly 1 x 201, rest 409.
 * Also supports --mode=spread: each request targets seat i % seatCount → expect seatCount wins.
 *
 * Requires server with RATE_LIMIT_DISABLED=1 (otherwise token bucket will 429).
 *
 * Usage:
 *   node scripts/bench-hold.js [--requests=100] [--runs=1] [--mode=same|spread] [--showId=1]
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const BASE = args.base ?? `http://localhost:${process.env.PORT ?? 3200}`;
const REQUESTS = Number(args.requests ?? 100);
const RUNS = Number(args.runs ?? 1);
const MODE = args.mode ?? 'same'; // same | spread
const SHOW_ID = Number(args.showId ?? 1);

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function ensureUsers(n) {
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const { rows } = await pool.query(
      `INSERT INTO users (email, role) VALUES ($1, 'USER')
       ON CONFLICT (email) DO UPDATE SET role = users.role
       RETURNING id`,
      [`bench${i}@bms.local`],
    );
    ids.push(Number(rows[0].id));
  }
  return ids;
}

async function resetShowInventory(showId) {
  await pool.query('BEGIN');
  try {
    await pool.query(
      `DELETE FROM booking_seats WHERE booking_id IN (SELECT id FROM bookings WHERE show_id = $1)`,
      [showId],
    );
    await pool.query(`DELETE FROM bookings WHERE show_id = $1`, [showId]);
    // Clear FK from show_seats before deleting holds.
    await pool.query(
      `UPDATE show_seats
       SET status = 'AVAILABLE', hold_id = NULL, held_until = NULL, version = 0
       WHERE show_id = $1`,
      [showId],
    );
    await pool.query(
      `DELETE FROM hold_seats WHERE hold_id IN (SELECT id FROM holds WHERE show_id = $1)`,
      [showId],
    );
    await pool.query(`DELETE FROM holds WHERE show_id = $1`, [showId]);
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}

async function seatIdsForShow(showId) {
  const { rows } = await pool.query(
    `SELECT seat_id FROM show_seats WHERE show_id = $1 ORDER BY seat_id`,
    [showId],
  );
  return rows.map((r) => Number(r.seat_id));
}

async function inventoryState(showId) {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM show_seats WHERE show_id = $1 GROUP BY status`,
    [showId],
  );
  const out = { AVAILABLE: 0, HELD: 0, BOOKED: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

async function runOnce(userIds, seats) {
  await resetShowInventory(SHOW_ID);

  const started = performance.now();
  const results = await Promise.all(
    Array.from({ length: REQUESTS }, async (_, i) => {
      const userId = userIds[i % userIds.length];
      const seatIds =
        MODE === 'spread' ? [seats[i % seats.length]] : [seats[0]];
      const t0 = performance.now();
      const res = await fetch(`${BASE}/holds`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ showId: SHOW_ID, userId, seatIds }),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, ms: performance.now() - t0, body };
    }),
  );
  const totalMs = performance.now() - started;
  const state = await inventoryState(SHOW_ID);
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const count = (status) => results.filter((r) => r.status === status).length;

  const expectedWins = MODE === 'spread' ? seats.length : 1;
  const wins = count(201);
  const ok = wins === expectedWins && state.HELD === expectedWins;

  return {
    mode: MODE,
    requests: REQUESTS,
    seats: seats.length,
    '201 held': wins,
    '409 conflict': count(409),
    '429 rate': count(429),
    '500 error': count(500),
    'held in db': state.HELD,
    'available in db': state.AVAILABLE,
    expectedWins,
    pass: ok,
    'total ms': Math.round(totalMs),
    'p50 ms': Math.round(percentile(latencies, 50)),
    'p95 ms': Math.round(percentile(latencies, 95)),
  };
}

console.log(
  `bench-hold base=${BASE} showId=${SHOW_ID} requests=${REQUESTS} mode=${MODE} runs=${RUNS}\n`,
);

const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) {
  console.error('Server not reachable. Start with: RATE_LIMIT_DISABLED=1 npm run server');
  process.exit(1);
}

const seats = await seatIdsForShow(SHOW_ID);
if (!seats.length) {
  console.error('No seats for show. Run npm run seed first.');
  process.exit(1);
}

const userIds = await ensureUsers(REQUESTS);
const rows = [];
for (let run = 1; run <= RUNS; run++) {
  rows.push({ ...(RUNS > 1 ? { run } : {}), ...(await runOnce(userIds, seats)) });
}
console.table(rows);

const failed = rows.some((r) => !r.pass);
await pool.end();
process.exit(failed ? 1 : 0);
