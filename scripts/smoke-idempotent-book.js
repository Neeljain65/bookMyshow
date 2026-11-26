/**
 * Hold once, POST /bookings twice for the same holdId.
 * Expect: same bookingId both times; second response idempotentReplay=true; only one row in DB.
 * Requires AUTH_DISABLED=1 and seeded inventory.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';

const base = process.env.BASE_URL ?? 'http://localhost:3200';

const health = await (await fetch(`${base}/health`)).json();
if (!health.authDisabled) {
  console.error('Set AUTH_DISABLED=1 and restart the API for this smoke test.');
  process.exit(1);
}

const seats = await (await fetch(`${base}/shows/1/seats`)).json();
const free = seats.seats.find((s) => s.status === 'AVAILABLE');
if (!free) {
  console.error('No free seat; reseed.');
  process.exit(1);
}

const holdRes = await fetch(`${base}/holds`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ showId: 1, userId: 1, seatIds: [Number(free.seat_id)] }),
});
const hold = await holdRes.json();
console.log('hold:', holdRes.status, hold);
if (!holdRes.ok) process.exit(1);

async function book() {
  const res = await fetch(`${base}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ holdId: hold.holdId, userId: 1 }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

const first = await book();
const second = await book();
console.log('first:', first.status, first.body);
console.log('second:', second.status, second.body);

const { rows } = await pool.query(
  `SELECT count(*)::int AS n FROM bookings WHERE hold_id = $1`,
  [hold.holdId],
);
console.log('bookings for hold:', rows[0].n);

await pool.end();

const ok =
  first.body.bookingId &&
  String(first.body.bookingId) === String(second.body.bookingId) &&
  second.body.idempotentReplay === true &&
  rows[0].n === 1 &&
  (first.status === 201 || first.status === 200) &&
  second.status === 200;

if (!ok) {
  console.error('FAIL');
  process.exit(1);
}
console.log('PASS');
