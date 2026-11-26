import { pool } from '../db/pool.js';
import { sendBookingConfirmationEmail, smtpConfigured } from '../mail.js';

/**
 * Handlers for background tasks.
 * Payment reconcile / lottery draw intentionally omitted until those features exist.
 */
export const handlers = {
  async notify_booking(payload) {
    const bookingId = payload.bookingId;
    const { rows } = await pool.query(
      `
      SELECT
        b.id, b.total_paise, b.status,
        u.email, u.name,
        m.title AS movie_title,
        sh.start_at AS show_start_at
      FROM bookings b
      JOIN users u ON u.id = b.user_id
      JOIN shows sh ON sh.id = b.show_id
      JOIN movies m ON m.id = sh.movie_id
      WHERE b.id = $1
      `,
      [bookingId],
    );
    if (!rows.length) throw new Error(`booking ${bookingId} not found`);

    const row = rows[0];
    const seats = await pool.query(
      `
      SELECT s.row_label, s.seat_number
      FROM booking_seats bs
      JOIN show_seats ss ON ss.id = bs.show_seat_id
      JOIN seats s ON s.id = ss.seat_id
      WHERE bs.booking_id = $1
      ORDER BY s.row_label, s.seat_number
      `,
      [bookingId],
    );

    if (!smtpConfigured()) {
      console.warn(
        `[notify_booking] SMTP not configured; logging only to=${row.email} booking=${row.id}`,
      );
      console.log(
        `[notify_booking] to=${row.email} booking=${row.id} movie="${row.movie_title}" seats=${seats.rows
          .map((s) => `${s.row_label}${s.seat_number}`)
          .join(',')} totalPaise=${row.total_paise}`,
      );
      return { emailed: false, logged: true, to: row.email };
    }

    const result = await sendBookingConfirmationEmail({
      to: row.email,
      name: row.name,
      bookingId: row.id,
      movieTitle: row.movie_title,
      showStartAt: row.show_start_at,
      seats: seats.rows,
      totalPaise: row.total_paise,
    });
    console.log(`[notify_booking] emailed to=${result.to} messageId=${result.messageId}`);
    return { emailed: true, ...result };
  },

  /** Force a failure path for smoke-testing retries / dead-letter. */
  async always_fail() {
    throw new Error('forced failure for DLQ smoke test');
  },
};
