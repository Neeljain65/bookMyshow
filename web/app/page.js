'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';

export default function HomePage() {
  const [cities, setCities] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .cities()
      .then((data) => setCities(data.cities || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section>
      <p className="muted" style={{ letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: '0.78rem' }}>
        BookMyShow lab
      </p>
      <h1>BMS</h1>
      <p>Pick a city to browse movies and lock seats for five minutes before you book.</p>

      {loading && <p>Loading cities…</p>}
      {error && <p className="error">{error}</p>}

      <div className="cardGrid">
        {cities.map((city) => (
          <Link key={city.id} href={`/city/${city.id}`} className="card">
            <strong>{city.name}</strong>
            <span>{city.slug}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
