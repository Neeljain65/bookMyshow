import { pool } from './pool.js';
import { cacheInvalidatePrefix } from '../cache.js';
import { connectRedis } from '../redis.js';

async function seed() {
  await connectRedis();
  await pool.query('BEGIN');
  try {
    await pool.query(`
      TRUNCATE
        jobs,
        booking_seats, bookings, hold_seats, show_seats, holds,
        show_pricing, shows, seats, seat_types, screens, venues,
        movies, cities, users
      RESTART IDENTITY CASCADE
    `);

    // Prefer SMTP_USER so local booking emails land in a real inbox during demos.
    const demoEmail = process.env.SMTP_USER || 'demo@bms.local';
    const user = await pool.query(
      `INSERT INTO users (email, name, role)
       VALUES ($1, 'Demo User', 'USER')
       RETURNING id, email, name`,
      [demoEmail],
    );

    const mumbai = await pool.query(
      `INSERT INTO cities (name, slug) VALUES ('Mumbai', 'mumbai') RETURNING id`,
    );
    const delhi = await pool.query(
      `INSERT INTO cities (name, slug) VALUES ('Delhi', 'delhi') RETURNING id`,
    );

    const movie = await pool.query(
      `INSERT INTO movies (title, type, duration_min, description)
       VALUES (
         'Demo Blockbuster',
         'movie',
         150,
         'A high-octane demo film used to exercise seating, holds, and bookings.'
       ) RETURNING id, title`,
    );
    const movie2 = await pool.query(
      `INSERT INTO movies (title, type, duration_min, description)
       VALUES (
         'Indie Night',
         'movie',
         110,
         'A quieter festival title — good for multi-city catalog caching demos.'
       ) RETURNING id, title`,
    );

    const venue = await pool.query(
      `INSERT INTO venues (city_id, name, address)
       VALUES ($1, 'PVR Phoenix', 'Lower Parel') RETURNING id`,
      [mumbai.rows[0].id],
    );
    const venueDelhi = await pool.query(
      `INSERT INTO venues (city_id, name, address)
       VALUES ($1, 'PVR Select Citywalk', 'Saket') RETURNING id`,
      [delhi.rows[0].id],
    );

    const screen = await pool.query(
      `INSERT INTO screens (venue_id, name) VALUES ($1, 'Screen 1') RETURNING id`,
      [venue.rows[0].id],
    );
    const screenDelhi = await pool.query(
      `INSERT INTO screens (venue_id, name) VALUES ($1, 'Audi 2') RETURNING id`,
      [venueDelhi.rows[0].id],
    );

    const silver = await pool.query(
      `INSERT INTO seat_types (code, display_name) VALUES ('SILVER', 'Silver') RETURNING id`,
    );
    const gold = await pool.query(
      `INSERT INTO seat_types (code, display_name) VALUES ('GOLD', 'Gold') RETURNING id`,
    );

    async function addSeats(screenId) {
      const seatIds = [];
      for (const [rowLabel, typeId] of [
        ['A', silver.rows[0].id],
        ['B', gold.rows[0].id],
      ]) {
        for (let n = 1; n <= 5; n++) {
          const seat = await pool.query(
            `INSERT INTO seats (screen_id, seat_type_id, row_label, seat_number)
             VALUES ($1, $2, $3, $4) RETURNING id, row_label, seat_number`,
            [screenId, typeId, rowLabel, n],
          );
          seatIds.push(seat.rows[0]);
        }
      }
      return seatIds;
    }

    async function addShow(movieId, screenId, seatRows, hoursFromNow) {
      const startAt = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000);
      const show = await pool.query(
        `INSERT INTO shows (movie_id, screen_id, start_at, status, admission_mode, hold_ttl_seconds)
         VALUES ($1, $2, $3, 'SCHEDULED', 'OPEN', 300)
         RETURNING id, start_at`,
        [movieId, screenId, startAt],
      );
      await pool.query(
        `INSERT INTO show_pricing (show_id, seat_type_id, amount_paise) VALUES
           ($1, $2, 25000),
           ($1, $3, 40000)`,
        [show.rows[0].id, silver.rows[0].id, gold.rows[0].id],
      );
      for (const seat of seatRows) {
        await pool.query(
          `INSERT INTO show_seats (show_id, seat_id, status) VALUES ($1, $2, 'AVAILABLE')`,
          [show.rows[0].id, seat.id],
        );
      }
      return show.rows[0];
    }

    const mumbaiSeats = await addSeats(screen.rows[0].id);
    const delhiSeats = await addSeats(screenDelhi.rows[0].id);
    const show = await addShow(movie.rows[0].id, screen.rows[0].id, mumbaiSeats, 24);
    await addShow(movie2.rows[0].id, screen.rows[0].id, mumbaiSeats, 30);
    await addShow(movie.rows[0].id, screenDelhi.rows[0].id, delhiSeats, 26);

    await pool.query('COMMIT');
    await cacheInvalidatePrefix('catalog:');

    console.log('seed: ok');
    console.log(
      JSON.stringify(
        {
          userId: user.rows[0].id,
          email: user.rows[0].email,
          cities: ['Mumbai', 'Delhi'],
          primaryShowId: show.id,
          movie: movie.rows[0].title,
          startAt: show.start_at,
          seats: mumbaiSeats.map((s) => `${s.row_label}${s.seat_number}`).join(', '),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  } finally {
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
