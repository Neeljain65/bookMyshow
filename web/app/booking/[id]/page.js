'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { api, formatInr } from '@/lib/api';

export default function BookingPage() {
  const { id } = useParams();
  const { getToken } = useAuth();
  const [booking, setBooking] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await getToken();
        const data = await api.booking(token, id);
        if (!cancelled) setBooking(data);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, id]);

  return (
    <section>
      <h1>Booking confirmed</h1>
      <p>A confirmation email is on its way (SMTP job).</p>
      {error && <p className="error">{error}</p>}
      {booking && (
        <div className="card" style={{ marginTop: '1.25rem', maxWidth: 480 }}>
          <strong>#{booking.id}</strong>
          <span style={{ display: 'block' }}>{booking.movie_title}</span>
          <span style={{ display: 'block' }}>
            {booking.start_at ? new Date(booking.start_at).toLocaleString() : ''}
          </span>
          <span style={{ display: 'block', marginTop: '0.5rem' }}>
            Seats:{' '}
            {(booking.seats || [])
              .map((s) => `${s.row_label}${s.seat_number}`)
              .join(', ')}
          </span>
          <span style={{ display: 'block' }}>Paid (ledger): {formatInr(booking.total_paise)}</span>
        </div>
      )}
      <p style={{ marginTop: '1.5rem' }}>
        <Link href="/bookings">My bookings</Link>
        {' · '}
        <Link href="/">Home</Link>
      </p>
    </section>
  );
}
