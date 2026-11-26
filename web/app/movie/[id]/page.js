'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

export default function MovieShowsPage() {
  const { id } = useParams();
  const search = useSearchParams();
  const cityId = search.get('cityId');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    api
      .showsForMovie(id, cityId)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [id, cityId]);

  return (
    <section>
      <Link href={cityId ? `/city/${cityId}` : '/'} className="muted">
        ← Movies
      </Link>
      <h1 style={{ marginTop: '1rem' }}>{data?.movie?.title || 'Shows'}</h1>
      <p>{data?.movie?.description || 'Pick a showtime.'}</p>
      {error && <p className="error">{error}</p>}
      <div className="cardGrid">
        {(data?.shows || []).map((show) => (
          <Link key={show.show_id} href={`/show/${show.show_id}`} className="card">
            <strong>{new Date(show.start_at).toLocaleString()}</strong>
            <span>
              {show.venue_name} · {show.screen_name}
            </span>
            <span style={{ display: 'block', marginTop: '0.4rem' }}>{show.city_name}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
