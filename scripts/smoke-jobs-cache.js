import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { enqueueJob, getJob } from '../src/jobs/queue.js';

const base = process.env.BASE_URL ?? 'http://localhost:3200';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const health = await (await fetch(`${base}/health`)).json();
console.log('health:', health);

const cities1 = await (await fetch(`${base}/cities`)).json();
const cities2 = await (await fetch(`${base}/cities`)).json();
console.log('cities cache sources:', cities1.cache, '→', cities2.cache, 'count=', cities1.cities.length);

const cityId = Number(cities1.cities[0].id);
const movies = await (await fetch(`${base}/cities/${cityId}/movies`)).json();
console.log('movies in city:', movies.movies.map((m) => m.title));

const movieId = Number(movies.movies[0].id);
const shows = await (await fetch(`${base}/movies/${movieId}/shows?cityId=${cityId}`)).json();
console.log('shows for movie in city:', shows.shows.length, 'cache=', shows.cache);

const showId = Number(shows.shows[0].show_id);
const seats = await (await fetch(`${base}/shows/${showId}/seats`)).json();
const free = seats.seats.find((s) => s.status === 'AVAILABLE');
const hold = await (
  await fetch(`${base}/holds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ showId, userId: 1, seatIds: [Number(free.seat_id)] }),
  })
).json();
const book = await (
  await fetch(`${base}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ holdId: hold.holdId, userId: 1 }),
  })
).json();
console.log('booking notifyJobId=', book.notifyJobId);

let job;
for (let i = 0; i < 20; i++) {
  await sleep(200);
  job = await getJob(book.notifyJobId);
  if (job?.status === 'done') break;
}
console.log('notify job:', job?.status, job?.task);

// DLQ path: always_fail with max_attempts=2
const failJobRow = await enqueueJob('always_fail', {}, { maxAttempts: 2 });
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const j = await getJob(failJobRow.id);
  if (j.status === 'dead') {
    console.log('dead-letter job:', j.status, j.attempts, j.last_error);
    break;
  }
  if (i === 29) console.log('DLQ job still:', j.status, j.attempts);
}

await pool.end();
console.log('PASS');
