import nodemailer from 'nodemailer';
import { config } from './config.js';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!config.smtp.user || !config.smtp.pass) {
    return null;
  }
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });
  return transporter;
}

export function smtpConfigured() {
  return Boolean(config.smtp.user && config.smtp.pass);
}

/**
 * Send booking confirmation. Throws on SMTP failure so the job can retry.
 */
export async function sendBookingConfirmationEmail({
  to,
  name,
  bookingId,
  movieTitle,
  showStartAt,
  seats,
  totalPaise,
}) {
  const tx = getTransporter();
  if (!tx) {
    throw new Error('SMTP is not configured (set SMTP_USER and SMTP_PASS)');
  }

  const seatList = seats.map((s) => `${s.row_label}${s.seat_number}`).join(', ');
  const totalInr = (totalPaise / 100).toFixed(2);
  const when = showStartAt ? new Date(showStartAt).toLocaleString('en-IN') : 'TBA';
  const greeting = name ? `Hi ${name},` : 'Hi,';

  const info = await tx.sendMail({
    from: config.smtp.from,
    to,
    subject: `Booking confirmed #${bookingId} — ${movieTitle}`,
    text: [
      greeting,
      '',
      'Your seats are booked.',
      `Booking ID: ${bookingId}`,
      `Movie: ${movieTitle}`,
      `Show: ${when}`,
      `Seats: ${seatList}`,
      `Total: ₹${totalInr}`,
      '',
      '— BMS',
    ].join('\n'),
    html: `
      <p>${greeting}</p>
      <p>Your seats are <strong>booked</strong>.</p>
      <ul>
        <li><strong>Booking ID:</strong> ${bookingId}</li>
        <li><strong>Movie:</strong> ${movieTitle}</li>
        <li><strong>Show:</strong> ${when}</li>
        <li><strong>Seats:</strong> ${seatList}</li>
        <li><strong>Total:</strong> ₹${totalInr}</li>
      </ul>
      <p>— BMS</p>
    `,
  });

  return { messageId: info.messageId, to };
}
