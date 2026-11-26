import { pool } from './pool.js';

const sql = `
CREATE TABLE IF NOT EXISTS users (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  name       text,
  clerk_id   text UNIQUE,
  role       text NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cities (
  id   bigserial PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS movies (
  id           bigserial PRIMARY KEY,
  title        text NOT NULL,
  type         text NOT NULL DEFAULT 'movie' CHECK (type IN ('movie', 'concert', 'other')),
  duration_min int  NOT NULL DEFAULT 120,
  description  text NOT NULL DEFAULT '',
  poster_url   text
);

CREATE TABLE IF NOT EXISTS venues (
  id      bigserial PRIMARY KEY,
  city_id bigint NOT NULL REFERENCES cities(id),
  name    text NOT NULL,
  address text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS screens (
  id       bigserial PRIMARY KEY,
  venue_id bigint NOT NULL REFERENCES venues(id),
  name     text NOT NULL
);

CREATE TABLE IF NOT EXISTS seat_types (
  id           bigserial PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  display_name text NOT NULL
);

CREATE TABLE IF NOT EXISTS seats (
  id           bigserial PRIMARY KEY,
  screen_id    bigint NOT NULL REFERENCES screens(id),
  seat_type_id bigint NOT NULL REFERENCES seat_types(id),
  row_label    text NOT NULL,
  seat_number  int  NOT NULL,
  UNIQUE (screen_id, row_label, seat_number)
);

CREATE TABLE IF NOT EXISTS shows (
  id                     bigserial PRIMARY KEY,
  movie_id               bigint NOT NULL REFERENCES movies(id),
  screen_id              bigint NOT NULL REFERENCES screens(id),
  start_at               timestamptz NOT NULL,
  status                 text NOT NULL DEFAULT 'SCHEDULED'
                           CHECK (status IN ('SCHEDULED', 'CANCELLED', 'COMPLETED')),
  admission_mode         text NOT NULL DEFAULT 'OPEN'
                           CHECK (admission_mode IN ('OPEN', 'QUEUE', 'LOTTERY')),
  hold_ttl_seconds       int NOT NULL DEFAULT 600,
  UNIQUE (screen_id, start_at)
);

CREATE TABLE IF NOT EXISTS show_pricing (
  show_id      bigint NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seat_type_id bigint NOT NULL REFERENCES seat_types(id),
  amount_paise int    NOT NULL CHECK (amount_paise >= 0),
  PRIMARY KEY (show_id, seat_type_id)
);

CREATE TABLE IF NOT EXISTS show_seats (
  id         bigserial PRIMARY KEY,
  show_id    bigint NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  seat_id    bigint NOT NULL REFERENCES seats(id),
  status     text NOT NULL DEFAULT 'AVAILABLE'
               CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
  hold_id    bigint,
  held_until timestamptz,
  version    int NOT NULL DEFAULT 0,
  UNIQUE (show_id, seat_id)
);

CREATE INDEX IF NOT EXISTS show_seats_show_status_idx
  ON show_seats (show_id, status);

CREATE TABLE IF NOT EXISTS holds (
  id         bigserial PRIMARY KEY,
  show_id    bigint NOT NULL REFERENCES shows(id),
  user_id    bigint NOT NULL REFERENCES users(id),
  status     text NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE', 'EXPIRED', 'CONSUMED', 'CANCELLED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE show_seats
  DROP CONSTRAINT IF EXISTS show_seats_hold_id_fkey;
ALTER TABLE show_seats
  ADD CONSTRAINT show_seats_hold_id_fkey
  FOREIGN KEY (hold_id) REFERENCES holds(id);

CREATE TABLE IF NOT EXISTS hold_seats (
  hold_id      bigint NOT NULL REFERENCES holds(id) ON DELETE CASCADE,
  show_seat_id bigint NOT NULL REFERENCES show_seats(id),
  PRIMARY KEY (hold_id, show_seat_id)
);

CREATE TABLE IF NOT EXISTS bookings (
  id          bigserial PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id),
  show_id     bigint NOT NULL REFERENCES shows(id),
  hold_id     bigint REFERENCES holds(id),
  status      text NOT NULL DEFAULT 'CONFIRMED'
                CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'FAILED')),
  total_paise int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booking_seats (
  booking_id   bigint NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  show_seat_id bigint NOT NULL REFERENCES show_seats(id),
  price_paise  int    NOT NULL,
  PRIMARY KEY (booking_id, show_seat_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id          bigserial PRIMARY KEY,
  task        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead')),
  attempts    int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  run_at      timestamptz NOT NULL DEFAULT now(),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (run_at)
  WHERE status = 'pending';

-- One confirmed booking per hold (idempotent double-click on Book).
CREATE UNIQUE INDEX IF NOT EXISTS bookings_hold_id_uidx
  ON bookings (hold_id)
  WHERE hold_id IS NOT NULL;
`;

const alterSql = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS clerk_id text;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_clerk_id_key'
  ) THEN
    ALTER TABLE users ADD CONSTRAINT users_clerk_id_key UNIQUE (clerk_id);
  END IF;
END $$;

ALTER TABLE movies ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE movies ADD COLUMN IF NOT EXISTS poster_url text;
`;

async function migrate() {
  await pool.query(sql);
  await pool.query(alterSql);
  console.log('migrate: ok');
  await pool.end();
}

migrate().catch((err) => {
  console.error('migrate failed:', err.message);
  process.exit(1);
});
