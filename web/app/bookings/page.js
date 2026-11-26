'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import { api, formatInr } from '@/lib/api';

export default function MyBookingsPage() {
  const { getToken } = useAuth();
  const [bookings, setBookings] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const data = await api.myBookings(token);
        setBookings(data.bookings || []);
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [getToken]);

  return (
    <section>
      <h1>My bookings</h1>
      {error && <p className="error">{error}</p>}
      <div className="cardGrid">
        {bookings.map((b) => (
          <Link key={b.id} href={`/booking/${b.id}`} className="card">
            <strong>{b.movie_title}</strong>
            <span>{b.start_at ? new Date(b.start_at).toLocaleString() : ''}</span>
            <span style={{ display: 'block', marginTop: '0.35rem' }}>
              #{b.id} · {formatInr(b.total_paise)} · {b.status}
            </span>
          </Link>
        ))}
      </div>
      {!bookings.length && !error && <p>No bookings yet.</p>}
    </section>
  );
}
