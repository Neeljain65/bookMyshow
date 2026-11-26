const base = process.env.BASE_URL ?? 'http://localhost:3200';

const shows = await (await fetch(`${base}/shows`)).json();
console.log('shows:', shows.shows.length, 'showId=', shows.shows[0]?.show_id);

const showId = Number(shows.shows[0].show_id);
const seatMap = await (await fetch(`${base}/shows/${showId}/seats`)).json();
console.log('seats:', seatMap.seats.length);

const seatIds = seatMap.seats.slice(0, 2).map((s) => Number(s.seat_id));
const holdRes = await fetch(`${base}/holds`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ showId, userId: 1, seatIds }),
});
const hold = await holdRes.json();
console.log('hold:', holdRes.status, hold);

const bookRes = await fetch(`${base}/bookings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ holdId: hold.holdId, userId: 1 }),
});
const book = await bookRes.json();
console.log('book:', bookRes.status, book);

const conflictRes = await fetch(`${base}/holds`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ showId, userId: 1, seatIds }),
});
console.log('conflict:', conflictRes.status, await conflictRes.json());
