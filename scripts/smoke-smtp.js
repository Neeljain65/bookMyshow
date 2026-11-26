/**
 * Hold → book → wait for notify_booking job.
 * Requires AUTH_DISABLED=1 and a seeded user id=1.
 * With SMTP configured, check the inbox for SMTP_USER / demo user's email.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { getJob } from '../src/jobs/queue.js';

const base = process.env.BASE_URL ?? 'http://localhost:3200';

const health = await (await fetch(`${base}/health`)).json();
console.log('health:', health);

const seats = await (await fetch(`${base}/shows/1/seats`)).json();
const free = seats.seats.find((s) => s.status === 'AVAILABLE');
if (!free) {
  console.error('No free seats; reseed.');
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

const bookRes = await fetch(`${base}/bookings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ holdId: hold.holdId, userId: 1 }),
});
const book = await bookRes.json();
console.log('book:', bookRes.status, book);
if (!bookRes.ok) process.exit(1);

let job;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 300));
  job = await getJob(book.notifyJobId);
  if (job && (job.status === 'done' || job.status === 'dead')) break;
}

console.log('notify job:', job?.status, job?.last_error ?? null);
await pool.end();

if (job?.status !== 'done') {
  console.error('FAIL: notify job did not complete');
  process.exit(1);
}
console.log('PASS — if smtpConfigured=true, check inbox for demo@bms.local (or update that user email)');
