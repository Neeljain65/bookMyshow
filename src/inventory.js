import { pool, withTx } from './db/pool.js';
import { config } from './config.js';
import { enqueueJob } from './jobs/queue.js';

export class ConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ConflictError';
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/**
 * Free expired HELD seats and mark their holds EXPIRED.
 * Used opportunistically inside hold/confirm, and by the expiry worker.
 */
export async function expireExpiredHolds(clientOrPool = pool, { showId = null, showSeatIds = null } = {}) {
  const db = clientOrPool;
  const params = [];
  const where = [`ss.status = 'HELD'`, `ss.held_until < now()`];

  if (showId != null) {
    params.push(showId);
    where.push(`ss.show_id = $${params.length}`);
  }
  if (showSeatIds?.length) {
    params.push(showSeatIds);
    where.push(`ss.id = ANY($${params.length}::bigint[])`);
  }

  const { rows } = await db.query(
    `
    WITH expired AS (
      SELECT ss.id AS show_seat_id, ss.hold_id
      FROM show_seats ss
      WHERE ${where.join(' AND ')}
    ),
    freed AS (
      UPDATE show_seats ss
      SET status = 'AVAILABLE', hold_id = NULL, held_until = NULL, version = version + 1
      FROM expired e
      WHERE ss.id = e.show_seat_id
      RETURNING e.hold_id
    ),
    marked AS (
      UPDATE holds h
      SET status = 'EXPIRED'
      WHERE h.id IN (SELECT DISTINCT hold_id FROM freed WHERE hold_id IS NOT NULL)
        AND h.status = 'ACTIVE'
      RETURNING h.id
    )
    SELECT
      (SELECT count(*)::int FROM freed) AS seats_freed,
      (SELECT count(*)::int FROM marked) AS holds_expired
    `,
    params,
  );

  return {
    seatsFreed: rows[0]?.seats_freed ?? 0,
    holdsExpired: rows[0]?.holds_expired ?? 0,
  };
}

async function reclaimExpiredHolds(client, showId, showSeatIds = null) {
  return expireExpiredHolds(client, { showId, showSeatIds });
}

/**
 * Hold seats with pessimistic locking (SELECT ... FOR UPDATE).
 * seatIds are physical seat ids for the show's screen.
 */
export async function holdSeats({ showId, userId, seatIds }) {
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new ConflictError('seatIds required');
  }
  const uniqueSeatIds = [...new Set(seatIds.map(Number))];
  if (uniqueSeatIds.length > config.maxSeatsPerHold) {
    throw new ConflictError(`at most ${config.maxSeatsPerHold} seats per hold`, {
      maxSeatsPerHold: config.maxSeatsPerHold,
    });
  }

  return withTx(async (client) => {
    const showRes = await client.query(
      `SELECT id, hold_ttl_seconds, status, admission_mode
       FROM shows WHERE id = $1`,
      [showId],
    );
    if (showRes.rowCount === 0) throw new NotFoundError('show not found');
    const show = showRes.rows[0];
    if (show.status !== 'SCHEDULED') throw new ConflictError('show not bookable');
    if (show.admission_mode !== 'OPEN') {
      throw new ConflictError('only OPEN admission is supported in v1');
    }

    const userRes = await client.query(`SELECT id FROM users WHERE id = $1`, [userId]);
    if (userRes.rowCount === 0) throw new NotFoundError('user not found');

    // Resolve show_seat rows for the requested physical seats.
    const mapped = await client.query(
      `SELECT ss.id, ss.seat_id, ss.status, ss.held_until
       FROM show_seats ss
       WHERE ss.show_id = $1 AND ss.seat_id = ANY($2::bigint[])
       ORDER BY ss.id`,
      [showId, uniqueSeatIds],
    );
    if (mapped.rowCount !== uniqueSeatIds.length) {
      throw new ConflictError('one or more seats do not belong to this show', {
        requested: uniqueSeatIds.length,
        found: mapped.rowCount,
      });
    }

    const showSeatIds = mapped.rows.map((r) => r.id);
    await reclaimExpiredHolds(client, showId, showSeatIds);

    // Lock rows in stable id order to avoid deadlocks.
    const locked = await client.query(
      `SELECT id, seat_id, status, held_until
       FROM show_seats
       WHERE id = ANY($1::bigint[])
       ORDER BY id
       FOR UPDATE`,
      [showSeatIds],
    );

    const unavailable = locked.rows.filter((r) => r.status !== 'AVAILABLE');
    if (unavailable.length) {
      throw new ConflictError('one or more seats are not available', {
        unavailableSeatIds: unavailable.map((r) => r.seat_id),
      });
    }

    const ttl = show.hold_ttl_seconds || config.holdTtlSeconds;
    const holdRes = await client.query(
      `INSERT INTO holds (show_id, user_id, status, expires_at)
       VALUES ($1, $2, 'ACTIVE', now() + make_interval(secs => $3))
       RETURNING id, expires_at`,
      [showId, userId, ttl],
    );
    const hold = holdRes.rows[0];

    await client.query(
      `UPDATE show_seats
       SET status = 'HELD', hold_id = $1, held_until = $2, version = version + 1
       WHERE id = ANY($3::bigint[])`,
      [hold.id, hold.expires_at, showSeatIds],
    );

    await client.query(
      `INSERT INTO hold_seats (hold_id, show_seat_id)
       SELECT $1, unnest($2::bigint[])`,
      [hold.id, showSeatIds],
    );

    return {
      holdId: hold.id,
      showId,
      userId,
      seatIds: uniqueSeatIds,
      expiresAt: hold.expires_at,
    };
  });
}

async function bookingReplayPayload(client, { holdId, showId, userId }) {
  const existing = await client.query(
    `SELECT id, total_paise, created_at, status FROM bookings WHERE hold_id = $1`,
    [holdId],
  );
  if (!existing.rowCount) return null;

  const seats = await client.query(
    `SELECT ss.seat_id
     FROM hold_seats hs
     JOIN show_seats ss ON ss.id = hs.show_seat_id
     WHERE hs.hold_id = $1
     ORDER BY ss.id`,
    [holdId],
  );
  const b = existing.rows[0];
  return {
    bookingId: b.id,
    showId,
    userId,
    seatIds: seats.rows.map((r) => r.seat_id),
    totalPaise: b.total_paise,
    status: b.status,
    createdAt: b.created_at,
    idempotentReplay: true,
  };
}

/** Confirm a hold into a booking (v1: no payment provider yet). Safe to call twice for the same holdId. */
export async function confirmBooking({ holdId, userId }) {
  return withTx(async (client) => {
    const holdRes = await client.query(
      `SELECT id, show_id, user_id, status, expires_at
       FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId],
    );
    if (holdRes.rowCount === 0) throw new NotFoundError('hold not found');
    const hold = holdRes.rows[0];
    if (Number(hold.user_id) !== Number(userId)) {
      throw new ConflictError('hold belongs to a different user');
    }

    // Already booked (double-click / retry after success): return the same booking.
    if (hold.status === 'CONSUMED') {
      const replay = await bookingReplayPayload(client, {
        holdId,
        showId: hold.show_id,
        userId,
      });
      if (replay) return replay;
      throw new ConflictError('hold is consumed but booking is missing');
    }

    if (hold.status !== 'ACTIVE') throw new ConflictError(`hold is ${hold.status}`);
    if (new Date(hold.expires_at) < new Date()) {
      await reclaimExpiredHolds(client, hold.show_id);
      throw new ConflictError('hold has expired');
    }

    const seats = await client.query(
      `SELECT ss.id AS show_seat_id, ss.seat_id, ss.status, ss.hold_id, sp.amount_paise
       FROM hold_seats hs
       JOIN show_seats ss ON ss.id = hs.show_seat_id
       JOIN seats s ON s.id = ss.seat_id
       JOIN show_pricing sp ON sp.show_id = ss.show_id AND sp.seat_type_id = s.seat_type_id
       WHERE hs.hold_id = $1
       ORDER BY ss.id
       FOR UPDATE OF ss`,
      [holdId],
    );
    if (seats.rowCount === 0) throw new ConflictError('hold has no seats');

    // Race: another request may have finished booking while we waited on locks.
    const earlyReplay = await bookingReplayPayload(client, {
      holdId,
      showId: hold.show_id,
      userId,
    });
    if (earlyReplay) return earlyReplay;

    const bad = seats.rows.filter(
      (r) => r.status !== 'HELD' || Number(r.hold_id) !== Number(holdId),
    );
    if (bad.length) throw new ConflictError('hold seats are no longer held');

    const total = seats.rows.reduce((sum, r) => sum + r.amount_paise, 0);
    let booking;
    try {
      const bookingRes = await client.query(
        `INSERT INTO bookings (user_id, show_id, hold_id, status, total_paise)
         VALUES ($1, $2, $3, 'CONFIRMED', $4)
         RETURNING id, total_paise, created_at`,
        [userId, hold.show_id, holdId, total],
      );
      booking = bookingRes.rows[0];
    } catch (err) {
      // Unique index bookings_hold_id_uidx: another concurrent confirm won.
      if (err.code === '23505') {
        const replay = await bookingReplayPayload(client, {
          holdId,
          showId: hold.show_id,
          userId,
        });
        if (replay) return replay;
      }
      throw err;
    }

    for (const row of seats.rows) {
      await client.query(
        `INSERT INTO booking_seats (booking_id, show_seat_id, price_paise)
         VALUES ($1, $2, $3)`,
        [booking.id, row.show_seat_id, row.amount_paise],
      );
    }

    await client.query(
      `UPDATE show_seats
       SET status = 'BOOKED', held_until = NULL, version = version + 1
       WHERE hold_id = $1 AND status = 'HELD'`,
      [holdId],
    );

    await client.query(`UPDATE holds SET status = 'CONSUMED' WHERE id = $1`, [holdId]);

    const job = await enqueueJob(
      'notify_booking',
      { bookingId: Number(booking.id) },
      { client },
    );

    return {
      bookingId: booking.id,
      showId: hold.show_id,
      userId,
      seatIds: seats.rows.map((r) => r.seat_id),
      totalPaise: booking.total_paise,
      status: 'CONFIRMED',
      createdAt: booking.created_at,
      notifyJobId: job.id,
      idempotentReplay: false,
    };
  });
}

/** Release an ACTIVE hold early; seats return to AVAILABLE. */
export async function cancelHold({ holdId, userId }) {
  return withTx(async (client) => {
    const holdRes = await client.query(
      `SELECT id, show_id, user_id, status
       FROM holds WHERE id = $1 FOR UPDATE`,
      [holdId],
    );
    if (holdRes.rowCount === 0) throw new NotFoundError('hold not found');
    const hold = holdRes.rows[0];
    if (Number(hold.user_id) !== Number(userId)) {
      throw new ConflictError('hold belongs to a different user');
    }
    if (hold.status !== 'ACTIVE') throw new ConflictError(`hold is ${hold.status}`);

    const seats = await client.query(
      `SELECT ss.id
       FROM hold_seats hs
       JOIN show_seats ss ON ss.id = hs.show_seat_id
       WHERE hs.hold_id = $1
       ORDER BY ss.id
       FOR UPDATE OF ss`,
      [holdId],
    );

    await client.query(
      `UPDATE show_seats
       SET status = 'AVAILABLE', hold_id = NULL, held_until = NULL, version = version + 1
       WHERE hold_id = $1 AND status = 'HELD'`,
      [holdId],
    );

    await client.query(`UPDATE holds SET status = 'CANCELLED' WHERE id = $1`, [holdId]);

    return {
      holdId,
      showId: hold.show_id,
      userId,
      status: 'CANCELLED',
      seatsReleased: seats.rowCount,
    };
  });
}
