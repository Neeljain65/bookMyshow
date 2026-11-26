import { pool } from './db/pool.js';
import { expireExpiredHolds, NotFoundError } from './inventory.js';
import { cacheAside } from './cache.js';
import { config } from './config.js';

const TTL = () => config.cache.catalogTtlSec;

export async function listCities() {
  const { data, source } = await cacheAside('catalog:cities', TTL(), async () => {
    const { rows } = await pool.query(
      `SELECT id, name, slug FROM cities ORDER BY name`,
    );
    return rows;
  });
  return { cities: data, cache: source };
}

export async function listMoviesByCity(cityId) {
  const { data, source } = await cacheAside(`catalog:city:${cityId}:movies`, TTL(), async () => {
    const city = await pool.query(`SELECT id, name, slug FROM cities WHERE id = $1`, [cityId]);
    if (city.rowCount === 0) throw new NotFoundError('city not found');

    // Movies that have at least one scheduled show in this city (bulk join, no N+1).
    const { rows } = await pool.query(
      `
      SELECT DISTINCT m.id, m.title, m.type, m.duration_min, m.description, m.poster_url
      FROM movies m
      JOIN shows sh ON sh.movie_id = m.id AND sh.status = 'SCHEDULED'
      JOIN screens sc ON sc.id = sh.screen_id
      JOIN venues v ON v.id = sc.venue_id
      WHERE v.city_id = $1
      ORDER BY m.title
      `,
      [cityId],
    );
    return { city: city.rows[0], movies: rows };
  });
  return { ...data, cache: source };
}

export async function getMovie(movieId) {
  const { data, source } = await cacheAside(`catalog:movie:${movieId}`, TTL(), async () => {
    const { rows } = await pool.query(
      `SELECT id, title, type, duration_min, description, poster_url
       FROM movies WHERE id = $1`,
      [movieId],
    );
    if (!rows.length) throw new NotFoundError('movie not found');
    return rows[0];
  });
  return { movie: data, cache: source };
}

export async function listShows({ cityId = null, movieId = null } = {}) {
  const cacheKey = `catalog:shows:city=${cityId ?? 'all'}:movie=${movieId ?? 'all'}`;
  const { data, source } = await cacheAside(cacheKey, TTL(), async () => {
    const params = [];
    const where = [`sh.status = 'SCHEDULED'`];

    if (cityId != null) {
      params.push(cityId);
      where.push(`v.city_id = $${params.length}`);
    }
    if (movieId != null) {
      params.push(movieId);
      where.push(`sh.movie_id = $${params.length}`);
    }

    const { rows } = await pool.query(
      `
      SELECT
        sh.id AS show_id,
        sh.start_at,
        sh.status,
        sh.admission_mode,
        sh.hold_ttl_seconds,
        m.id AS movie_id,
        m.title AS movie_title,
        v.id AS venue_id,
        v.name AS venue_name,
        c.id AS city_id,
        c.name AS city_name,
        sc.name AS screen_name
      FROM shows sh
      JOIN movies m ON m.id = sh.movie_id
      JOIN screens sc ON sc.id = sh.screen_id
      JOIN venues v ON v.id = sc.venue_id
      JOIN cities c ON c.id = v.city_id
      WHERE ${where.join(' AND ')}
      ORDER BY sh.start_at
      `,
      params,
    );
    return rows;
  });
  return { shows: data, cache: source };
}

export async function listShowsForMovie(movieId, { cityId = null } = {}) {
  const { movie } = await getMovie(movieId);
  const { shows, cache } = await listShows({ movieId, cityId });
  return { movie, shows, cache };
}

export async function getShowSeats(showId) {
  const show = await pool.query(
    `SELECT id, start_at, status, admission_mode FROM shows WHERE id = $1`,
    [showId],
  );
  if (show.rowCount === 0) throw new NotFoundError('show not found');

  // Live inventory: do not cache-aside (or only very short TTL — we skip caching).
  await expireExpiredHolds(pool, { showId });

  const { rows } = await pool.query(
    `
    SELECT
      s.id AS seat_id,
      s.row_label,
      s.seat_number,
      st.code AS seat_type,
      sp.amount_paise,
      ss.status,
      ss.held_until
    FROM show_seats ss
    JOIN seats s ON s.id = ss.seat_id
    JOIN seat_types st ON st.id = s.seat_type_id
    JOIN show_pricing sp ON sp.show_id = ss.show_id AND sp.seat_type_id = s.seat_type_id
    WHERE ss.show_id = $1
    ORDER BY s.row_label, s.seat_number
    `,
    [showId],
  );

  return { show: show.rows[0], seats: rows };
}

export async function getBooking(bookingId, { userId = null } = {}) {
  const booking = await pool.query(
    `
    SELECT b.id, b.user_id, b.show_id, b.status, b.total_paise, b.created_at, b.hold_id,
           m.title AS movie_title, sh.start_at
    FROM bookings b
    JOIN shows sh ON sh.id = b.show_id
    JOIN movies m ON m.id = sh.movie_id
    WHERE b.id = $1
    `,
    [bookingId],
  );
  if (booking.rowCount === 0) throw new NotFoundError('booking not found');
  if (userId != null && Number(booking.rows[0].user_id) !== Number(userId)) {
    throw new NotFoundError('booking not found');
  }

  const seats = await pool.query(
    `
    SELECT s.id AS seat_id, s.row_label, s.seat_number, bs.price_paise
    FROM booking_seats bs
    JOIN show_seats ss ON ss.id = bs.show_seat_id
    JOIN seats s ON s.id = ss.seat_id
    WHERE bs.booking_id = $1
    ORDER BY s.row_label, s.seat_number
    `,
    [bookingId],
  );

  return { ...booking.rows[0], seats: seats.rows };
}

export async function listBookingsForUser(userId) {
  const { rows } = await pool.query(
    `
    SELECT b.id, b.show_id, b.status, b.total_paise, b.created_at,
           m.title AS movie_title, sh.start_at
    FROM bookings b
    JOIN shows sh ON sh.id = b.show_id
    JOIN movies m ON m.id = sh.movie_id
    WHERE b.user_id = $1
    ORDER BY b.created_at DESC
    `,
    [userId],
  );
  return { bookings: rows };
}
