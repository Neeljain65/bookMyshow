/**
 * Fires many /holds quickly for the same user to show token-bucket 429s.
 * Expect: first ~RL_HOLD_CAPACITY succeed or 409 from seats; then 429.
 */
const base = process.env.BASE_URL ?? 'http://localhost:3200';

const seatsRes = await fetch(`${base}/shows/1/seats`);
const seatMap = await seatsRes.json();
const free = seatMap.seats.filter((s) => s.status === 'AVAILABLE').map((s) => Number(s.seat_id));

const results = { 201: 0, 409: 0, 429: 0, other: 0 };
const n = 25;

for (let i = 0; i < n; i++) {
  const seatIds = free.length ? [free[i % free.length]] : [1];
  const res = await fetch(`${base}/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ showId: 1, userId: 1, seatIds }),
  });
  const body = await res.json();
  if (results[res.status] !== undefined) results[res.status] += 1;
  else results.other += 1;
  if (res.status === 429) {
    console.log(`request ${i + 1}: 429`, body);
    break;
  }
}

console.log('counts (stopped at first 429 or finished):', results);
console.log('Defaults: hold capacity=10, refill=1/s → after burst you must wait ~1s per extra request.');
