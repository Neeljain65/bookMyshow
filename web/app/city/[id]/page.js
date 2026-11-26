'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';

export default function CityMoviesPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    api
      .moviesByCity(id)
      .then(setData)
      .catch((err) => setError(err.message));
  }, [id]);

  return (
    <section>
      <Link href="/" className="muted">
        ← Cities
      </Link>
      <h1 style={{ marginTop: '1rem' }}>{data?.city?.name || 'Movies'}</h1>
      <p>Choose a title playing in this city.</p>
      {error && <p className="error">{error}</p>}
      <div className="cardGrid">
        {(data?.movies || []).map((movie) => (
          <Link
            key={movie.id}
            href={`/movie/${movie.id}?cityId=${id}`}
            className="card"
          >
            <strong>{movie.title}</strong>
            <span>
              {movie.duration_min} min · {movie.type}
            </span>
            {movie.description ? (
              <span style={{ display: 'block', marginTop: '0.55rem' }}>
                {movie.description.slice(0, 110)}
                {movie.description.length > 110 ? '…' : ''}
              </span>
            ) : null}
          </Link>
        ))}
      </div>
    </section>
  );
}
