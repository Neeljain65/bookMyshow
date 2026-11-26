'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Show, SignInButton, useAuth } from '@clerk/nextjs';
import { api, formatInr } from '@/lib/api';
import styles from './seats.module.css';

export default function ShowSeatsPage() {
  const { id } = useParams();
  const router = useRouter();
  const { getToken, isSignedIn } = useAuth();
  const [payload, setPayload] = useState(null);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    api
      .showSeats(id)
      .then(setPayload)
      .catch((err) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  const byRow = useMemo(() => {
    const seats = payload?.seats || [];
    const map = new Map();
    for (const seat of seats) {
      if (!map.has(seat.row_label)) map.set(seat.row_label, []);
      map.get(seat.row_label).push(seat);
    }
    return [...map.entries()];
  }, [payload]);

  function toggleSeat(seat) {
    if (seat.status !== 'AVAILABLE') return;
    setSelected((prev) => {
      const exists = prev.find((s) => s.seat_id === seat.seat_id);
      if (exists) return prev.filter((s) => s.seat_id !== seat.seat_id);
      if (prev.length >= 6) {
        setError('You can select at most 6 seats');
        return prev;
      }
      setError('');
      return [...prev, seat];
    });
  }

  async function onContinue() {
    setError('');
    if (!isSignedIn) {
      setError('Sign in to continue and lock seats');
      return;
    }
    if (!selected.length) {
      setError('Select at least one seat');
      return;
    }
    setBusy(true);
    try {
      const token = await getToken();
      const hold = await api.hold(token, {
        showId: Number(id),
        seatIds: selected.map((s) => Number(s.seat_id)),
      });
      sessionStorage.setItem(
        'bms_checkout',
        JSON.stringify({
          holdId: hold.holdId,
          expiresAt: hold.expiresAt,
          showId: Number(id),
          seats: selected,
        }),
      );
      router.push('/checkout');
    } catch (err) {
      setError(err.message || 'Could not hold seats');
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <Link href="/" className="muted">
        ← Home
      </Link>
      <h1 style={{ marginTop: '1rem' }}>Select seats</h1>
      <p>Available seats can be held for 5 minutes after you continue.</p>

      <div className={styles.screen}>SCREEN</div>

      <div className={styles.map}>
        {byRow.map(([row, rowSeats]) => (
          <div key={row} className={styles.row}>
            <span className={styles.rowLabel}>{row}</span>
            <div className={styles.rowSeats}>
              {rowSeats.map((seat) => {
                const isSel = selected.some((s) => s.seat_id === seat.seat_id);
                const busySeat = seat.status !== 'AVAILABLE';
                return (
                  <button
                    key={seat.seat_id}
                    type="button"
                    className={`${styles.seat} ${isSel ? styles.selected : ''} ${
                      busySeat ? styles.taken : ''
                    }`}
                    disabled={busySeat}
                    onClick={() => toggleSeat(seat)}
                    title={`${seat.row_label}${seat.seat_number} · ${seat.seat_type} · ${formatInr(
                      seat.amount_paise,
                    )}`}
                  >
                    {seat.seat_number}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className={styles.legend}>
        <span>
          <i className={`${styles.swatch} ${styles.swatchFree}`} /> Free
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchSel}`} /> Selected
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.swatchBusy}`} /> Held / booked
        </span>
      </div>

      <div className={styles.bar}>
        <div>
          <strong>{selected.length}</strong> selected
          {selected.length > 0 && (
            <span className="muted">
              {' '}
              ·{' '}
              {selected.map((s) => `${s.row_label}${s.seat_number}`).join(', ')}
            </span>
          )}
        </div>
        <div className={styles.actions}>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <button type="button" className="btn btnSecondary">
                Sign in to continue
              </button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <button
              type="button"
              className="btn btnAccent"
              disabled={busy || !selected.length}
              onClick={onContinue}
            >
              {busy ? 'Locking…' : 'Continue'}
            </button>
          </Show>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
