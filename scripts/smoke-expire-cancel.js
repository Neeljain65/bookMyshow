/**
 * 1) Hold a seat with a very short TTL (forced via SQL), wait, run expire, expect AVAILABLE.
 * 2) Hold another seat, cancel via API, expect AVAILABLE.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { expireExpiredHolds } from '../src/inventory.js';

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3200}`;

async function main() {
  const seats = await (await fetch(`${BASE}/shows/1/seats`)).json();
  const available = seats.seats.filter((s) => s.status === 'AVAILABLE').map((s) => Number(s.seat_id));
  if (available.length < 2) {
    console.error('Need at least 2 available seats; reseed and retry.');
    process.exit(1);
  }

  // --- cancel path ---
  const holdRes = await fetch(`${BASE}/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ showId: 1, userId: 1, seatIds: [available[0]] }),
  });
  const hold = await holdRes.json();
  console.log('hold for cancel:', holdRes.status, hold);

  const cancelRes = await fetch(`${BASE}/holds/${hold.holdId}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 1 }),
  });
  const cancelled = await cancelRes.json();
  console.log('cancel:', cancelRes.status, cancelled);

  const afterCancel = await (await fetch(`${BASE}/shows/1/seats`)).json();
  const seatAfterCancel = afterCancel.seats.find((s) => Number(s.seat_id) === available[0]);
  console.log('seat after cancel:', seatAfterCancel?.status);

  // --- expire path ---
  const hold2Res = await fetch(`${BASE}/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ showId: 1, userId: 1, seatIds: [available[1]] }),
  });
  const hold2 = await hold2Res.json();
  console.log('hold for expire:', hold2Res.status, hold2);

  await pool.query(
    `UPDATE holds SET expires_at = now() - interval '1 second' WHERE id = $1`,
    [hold2.holdId],
  );
  await pool.query(
    `UPDATE show_seats SET held_until = now() - interval '1 second' WHERE hold_id = $1`,
    [hold2.holdId],
  );

  const expired = await expireExpiredHolds(pool);
  console.log('expire worker tick:', expired);

  const afterExpire = await (await fetch(`${BASE}/shows/1/seats`)).json();
  const seatAfterExpire = afterExpire.seats.find((s) => Number(s.seat_id) === available[1]);
  console.log('seat after expire:', seatAfterExpire?.status);

  const ok =
    seatAfterCancel?.status === 'AVAILABLE' &&
    seatAfterExpire?.status === 'AVAILABLE' &&
    cancelRes.status === 200 &&
    expired.seatsFreed >= 1;

  await pool.end();
  if (!ok) {
    console.error('FAIL');
    process.exit(1);
  }
  console.log('PASS');
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
